import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeProxyBridge, redactNetworkCredentials } from '../src/main/runtime-proxy.js'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => server.close())
  return (server.address() as { port: number }).port
}

async function connection(url: string, destination: string, authenticated = true): Promise<{ code: number; socket: Socket }> {
  const proxy = new URL(url)
  return new Promise((resolve, reject) => {
    const call = request({ hostname: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: destination,
      headers: authenticated ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` } : {} })
    call.once('error', reject)
    call.once('connect', (response, socket) => {
      cleanups.push(() => socket.destroy())
      resolve({ code: response.statusCode!, socket: socket as Socket })
    })
    call.end()
  })
}

describe('system proxy bridge', () => {
  it('resolves each actual destination and forwards opaque bytes through the upstream proxy', async () => {
    const targets: string[] = []
    const upstream = createServer()
    upstream.on('connect', (call, socket) => {
      targets.push(call.url!)
      cleanups.push(() => socket.destroy())
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.on('data', data => socket.write(data))
    })
    const port = await listen(upstream)
    const resolutions: string[] = []
    const bridge = new RuntimeProxyBridge(async url => { resolutions.push(url); return [`http://127.0.0.1:${port}`] })
    cleanups.push(() => bridge.close())
    const url = await bridge.start()
    for (const destination of ['pypi.org:443', 'files.pythonhosted.org:443', 'modelscope.cn:443']) {
      const result = await connection(url, destination)
      expect(result.code).toBe(200)
      const response = once(result.socket, 'data')
      result.socket.write('opaque TLS bytes 🎸')
      expect((await response)[0].toString()).toBe('opaque TLS bytes 🎸')
      result.socket.destroy()
    }
    expect(targets).toEqual(['pypi.org:443', 'files.pythonhosted.org:443', 'modelscope.cn:443'])
    expect(resolutions).toEqual(['https://pypi.org/', 'https://files.pythonhosted.org/', 'https://modelscope.cn/'])
  })

  it('refuses unauthenticated callers before consulting the system policy', async () => {
    let resolved = false
    const bridge = new RuntimeProxyBridge(async () => { resolved = true; return [null] })
    cleanups.push(() => bridge.close())
    expect((await connection(await bridge.start(), 'pypi.org:443', false)).code).toBe(407)
    expect(resolved).toBe(false)
  })

  it('never bypasses a failed policy without an explicit PAC fallback', async () => {
    const bridge = new RuntimeProxyBridge(async () => { throw new Error('PAC_UNAVAILABLE') })
    cleanups.push(() => bridge.close())
    expect((await connection(await bridge.start(), 'pypi.org:443')).code).toBe(502)
  })

  it('removes proxy credentials before installer progress and errors reach the renderer', () => {
    expect(redactNetworkCredentials('connect https://name:secret@proxy.local:8080/a')).toBe('connect https://***@proxy.local:8080/a')
    expect(redactNetworkCredentials('http://secret-token@proxy.local')).toBe('http://***@proxy.local')
  })
})
