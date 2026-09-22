import { session, type Session } from 'electron'
import type { NetworkSettings } from '@shared/domain.js'
import { RuntimeProxyBridge } from './runtime-proxy.js'

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']

export function proxyEnvironment(base: NodeJS.ProcessEnv, network: NetworkSettings, systemProxy?: string | null): NodeJS.ProcessEnv {
  const env = { ...base }
  if (network.proxyMode !== 'system' || systemProxy !== undefined) {
    for (const key of PROXY_KEYS) delete env[key]
    const proxy = network.proxyMode === 'manual' ? network.proxyUrl : network.proxyMode === 'system' ? systemProxy : null
    if (proxy) {
      env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxy
    }
    // urllib otherwise rediscovers the OS proxy even when explicitly disabled.
    if (network.proxyMode === 'none' || systemProxy === null) env.NO_PROXY = env.no_proxy = '*'
  }
  return env
}

export function proxyFromPac(result: string): string | null {
  for (const entry of result.split(';')) {
    const value = entry.trim()
    if (value === 'DIRECT') return null
    const match = /^(PROXY|HTTPS)\s+(.+)$/i.exec(value)
    if (match) return `${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
    // Python's standard downloader cannot speak SOCKS. Do not silently bypass it.
    if (/^SOCKS/i.test(value)) throw new Error('SYSTEM_PROXY_SOCKS_UNSUPPORTED:请设置 HTTP 代理地址')
  }
  return null
}

/** One network policy for Electron downloads and managed Python/uv processes. */
export class RuntimeNetwork {
  private client: Session | null = null
  private policy = ''
  private systemBridge: RuntimeProxyBridge | null = null

  private async configured(network: NetworkSettings): Promise<Session> {
    const client = this.client ??= session.fromPartition('bandbuddy-runtime-downloads')
    const policy = JSON.stringify([network.proxyMode, network.proxyUrl])
    if (policy !== this.policy) {
      await client.setProxy(network.proxyMode === 'manual'
        ? { mode: 'fixed_servers', proxyRules: network.proxyUrl, proxyBypassRules: '<-loopback>' }
        : { mode: network.proxyMode === 'none' ? 'direct' : 'system' })
      this.policy = policy
    }
    return client
  }

  async environment(base: NodeJS.ProcessEnv, network: NetworkSettings, _url?: string): Promise<NodeJS.ProcessEnv> {
    if (network.proxyMode !== 'system') return proxyEnvironment(base, network)
    if (!this.systemBridge) {
      const client = session.fromPartition('bandbuddy-runtime-system-routing')
      await client.setProxy({ mode: 'system' })
      this.systemBridge = new RuntimeProxyBridge(async url => {
        const policy = await client.resolveProxy(url)
        return policy.split(';').filter(entry => entry.trim()).map(entry => proxyFromPac(entry))
      })
    }
    return proxyEnvironment(base, network, await this.systemBridge.start())
  }

  close(): void { this.systemBridge?.close(); this.systemBridge = null }

  async bytes(urls: readonly string[], network: NetworkSettings, signal: AbortSignal, limit = 128 * 1024 * 1024): Promise<Buffer> {
    const client = await this.configured(network)
    let last: unknown
    for (const url of [...new Set(urls)]) {
      if (new URL(url).protocol !== 'https:') throw new Error('INSECURE_DOWNLOAD_URL')
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted()
        const controller = new AbortController()
        const cancel = (): void => controller.abort(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
        const timer = setTimeout(() => controller.abort(new Error('DOWNLOAD_TIMEOUT')), 120_000)
        try {
          const response = await client.fetch(url, { signal: controller.signal })
          if (!response.ok) throw new Error(`DOWNLOAD_HTTP_${response.status}`)
          const chunks: Buffer[] = []
          let size = 0
          if (!response.body) throw new Error('DOWNLOAD_EMPTY')
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength
            if (size > limit) { controller.abort(); throw new Error('DOWNLOAD_TOO_LARGE') }
            chunks.push(Buffer.from(chunk))
          }
          return Buffer.concat(chunks)
        } catch (error) {
          signal.throwIfAborted()
          last = error
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', cancel)
        }
      }
    }
    throw last ?? new Error('DOWNLOAD_FAILED')
  }
}
