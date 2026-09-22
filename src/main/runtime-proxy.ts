import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'

export function redactNetworkCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
}

async function openSocket(host: string, port: number, secure = false): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure ? connectTls({ host, port, servername: host }) : connect({ host, port })
    socket.setTimeout(30_000, () => socket.destroy(new Error('PROXY_CONNECT_TIMEOUT')))
    const failed = (error: Error): void => { socket.destroy(); reject(error) }
    socket.once('error', failed)
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.off('error', failed)
      resolve(socket)
    })
  })
}

async function tunnel(host: string, port: number, proxy: string | null): Promise<Socket> {
  if (!proxy) return openSocket(host, port)
  const target = new URL(proxy)
  const socket = await openSocket(target.hostname, Number(target.port || (target.protocol === 'https:' ? 443 : 80)), target.protocol === 'https:')
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const closed = (): void => { reject(new Error('SYSTEM_PROXY_CLOSED')) }
    const failed = (error: Error): void => { socket.off('close', closed); socket.destroy(); reject(error) }
    const read = (data: Buffer): void => {
      received = Buffer.concat([received, data])
      const end = received.indexOf('\r\n\r\n')
      if (end === -1 && received.length <= 16_384) return
      socket.off('data', read)
      socket.off('error', failed)
      socket.off('close', closed)
      if (end === -1 || !/^HTTP\/1\.[01] 200\b/.test(received.toString('ascii', 0, end))) {
        failed(new Error('SYSTEM_PROXY_CONNECT_FAILED'))
        return
      }
      socket.pause()
      if (received.length > end + 4) socket.unshift(received.subarray(end + 4))
      resolve(socket)
    }
    socket.once('error', failed)
    socket.once('close', closed)
    socket.on('data', read)
    const authorization = target.username || target.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64')}\r\n` : ''
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authorization}\r\n`)
  })
}

/** A loopback CONNECT bridge keeps uv/urllib on the same per-host PAC policy as Electron.
 * HTTPS is passed through unchanged: no certificates, decrypted bodies or credentials are logged.
 */
export class RuntimeProxyBridge {
  private server: Server | null = null
  private startTask: Promise<string> | null = null
  private readonly sockets = new Set<Socket>()
  private readonly password = randomBytes(24).toString('hex')

  constructor(private readonly resolve: (url: string) => Promise<readonly (string | null)[]>) {}

  start(): Promise<string> {
    if (this.startTask) return this.startTask
    this.startTask = new Promise((resolve, reject) => {
      const server = this.server = createServer((_request, response) => {
        response.writeHead(405).end('HTTPS CONNECT required')
      })
      server.on('connect', (request, stream, head) => {
        // This server only accepts TCP; Node types also allow a generic Duplex.
        const client = stream as Socket
        const expected = Buffer.from(`Basic ${Buffer.from(`bandbuddy:${this.password}`).toString('base64')}`)
        const actual = Buffer.from(request.headers['proxy-authorization'] ?? '')
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="BandBuddy"\r\nConnection: close\r\n\r\n')
          return
        }
        if (this.sockets.size >= 128) { client.end('HTTP/1.1 503 Busy\r\nConnection: close\r\n\r\n'); return }
        this.sockets.add(client)
        client.once('close', () => this.sockets.delete(client))
        client.on('error', () => client.destroy())
        client.setTimeout(120_000, () => client.destroy())
        void (async () => {
          const destination = new URL(`https://${request.url}`)
          if (destination.username || destination.password || destination.pathname !== '/' || destination.search || destination.hash) throw new Error('INVALID_PROXY_TARGET')
          const host = destination.hostname
          const port = Number(destination.port || 443)
          const proxies = await this.resolve(`https://${destination.host}/`)
          let remote: Socket | undefined
          for (const proxy of proxies) {
            try { remote = await tunnel(host, port, proxy); break } catch { /* Respect the next PAC fallback, if present. */ }
          }
          if (!remote) throw new Error('SYSTEM_PROXY_UNAVAILABLE')
          if (client.destroyed) { remote.destroy(); return }
          this.sockets.add(remote)
          remote.once('close', () => { this.sockets.delete(remote!); client.destroy() })
          client.once('close', () => remote!.destroy())
          remote.on('error', () => client.destroy())
          remote.setTimeout(120_000, () => remote!.destroy())
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) remote.write(head)
          client.pipe(remote)
          remote.pipe(client)
        })().catch(() => client.end('HTTP/1.1 502 Proxy connection failed\r\nConnection: close\r\n\r\n'))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.unref()
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('LOCAL_PROXY_UNAVAILABLE')); return }
        resolve(`http://bandbuddy:${this.password}@127.0.0.1:${address.port}`)
      })
    })
    return this.startTask
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
    this.startTask = null
  }
}
