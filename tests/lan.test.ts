import { createServer, request as httpRequest, type Server } from 'node:http'
import { createSocket } from 'node:dgram'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { LanService, LAN_PORT } from '../src/main/lan.js'
import { createDefaultPracticeState } from '@shared/domain.js'

const songId = '11111111-1111-4111-8111-111111111111'
const stemId = '22222222-2222-4222-8222-222222222222'
const bytes = Buffer.from('FLAC test audio data for resumable native downloads')

describe('LAN HTTP and discovery integration', () => {
  let root: string
  let service: LanService
  let blocker: Server
  let origin: string
  let session: string
  let discoveryPort: number
  const song = { id: songId, title: '测试曲目', artist: 'Band', durationMs: 12000, status: 'ready',
    updatedAt: '2026-09-22T00:00:00Z', stemTypes: ['lead_guitar'], sourceFormat: 'existing-stems',
    practice: createDefaultPracticeState(songId), lyrics: { fileName: 'song.lrc', title: null, artist: null, album: null, cues: [{ timeMs: 0, lines: ['第一句'] }] },
    artworkUrl: null, videoUrl: null, stems: [{ id: stemId, name: '我的主音吉他', type: 'lead_guitar', durationMs: 12000, sampleRate: 44100, channels: 2, peaksUrl: null }]
  }
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lan-test-'))
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'lan.html'), '<html>practice</html>')
    await writeFile(path.join(root, 'secret.txt'), 'never served')
    await writeFile(path.join(root, 'track.flac'), bytes)
    blocker = createServer()
    await new Promise<void>((resolve) => {
      blocker.once('error', () => resolve())
      blocker.listen(LAN_PORT, '0.0.0.0', resolve)
    })
    const discoveryProbe = createSocket('udp4')
    await new Promise<void>((resolve) => discoveryProbe.bind(0, '127.0.0.1', resolve))
    discoveryPort = discoveryProbe.address().port
    await new Promise<void>((resolve) => discoveryProbe.close(resolve))
    service = new LanService({
      listSongs: () => [song, { ...song, id: 'pending', status: 'processing' }],
      getSong: (id: string) => id === songId ? song : null
    } as never, {
      resolveProtocolPath: (url: URL) => url.pathname === `/${songId}/stem/${stemId}` ? path.join(root, 'track.flac') : null
    } as never, {} as never, { warn: vi.fn() } as never, root, discoveryPort)
    const status = await service.setEnabled(true)
    expect(status.enabled).toBe(true)
    expect(status.port).not.toBe(LAN_PORT)
    origin = `http://127.0.0.1:${status.port}`
  })
  afterAll(async () => { await service?.stop(); blocker?.closeAllConnections(); await new Promise<void>((resolve) => blocker?.close(() => resolve())); await rm(root, { recursive: true, force: true }) })

  it('discovers the fallback TCP port over HTTP and UDP', async () => {
    const response = await fetch(`${origin}/api/v1/discovery`)
    expect(await response.json()).toMatchObject({ service: 'bandbuddy-lan', version: 1, port: service.status().port })
    const socket = createSocket('udp4')
    const packet = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('UDP discovery timed out')) }, 2000)
      socket.once('message', (data) => { clearTimeout(timer); socket.close(); resolve(data.toString()) })
      socket.send(JSON.stringify({ service: 'bandbuddy-lan', type: 'discover', version: 1 }), discoveryPort, '127.0.0.1')
    })
    expect(JSON.parse(packet)).toMatchObject({ port: service.status().port, handshake: '/api/v1/handshake' })
  })
  it('validates handshakes and returns a session capability', async () => {
    expect((await fetch(`${origin}/api/v1/handshake`, { method: 'POST', body: '{}' })).status).toBe(415)
    expect((await fetch(`${origin}/api/v1/handshake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' })).status).toBe(400)
    const response = await fetch(`${origin}/api/v1/handshake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'bandbuddy-lan', version: 1, platform: 'ios' }) })
    expect(response.status).toBe(200)
    const handshake = await response.json()
    session = origin + handshake.basePath
    expect(handshake.basePath).toMatch(/^\/s\/[a-f0-9]{48}\/$/)
  })
  it('lists only ready songs and exports names, lyrics, visibility and checksums', async () => {
    const list = await (await fetch(`${session}api/v1/songs`)).json()
    expect(list.songs).toHaveLength(1)
    const manifest = await (await fetch(session + list.songs[0].manifest)).json()
    expect(manifest.stems[0]).toMatchObject({ name: '我的主音吉他', defaultVisible: true,
      audio: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'audio/flac' } })
    expect(manifest.lyrics.cues[0].lines).toEqual(['第一句'])
    expect(JSON.stringify(manifest)).not.toContain(root)
  })
  it('supports GET, HEAD, suffix/ranged downloads and rejects bad ranges', async () => {
    const url = `${session}media/${songId}/stem/${stemId}`
    const full = await fetch(url)
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes)
    const partial = await fetch(url, { headers: { Range: 'bytes=5-12' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe(`bytes 5-12/${bytes.length}`)
    expect(await partial.text()).toBe(bytes.subarray(5, 13).toString())
    const head = await fetch(url, { method: 'HEAD' })
    expect(head.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(await head.text()).toBe('')
    expect((await fetch(url, { headers: { Range: 'bytes=9000-' } })).status).toBe(416)
    expect((await fetch(url + '?web=1&pitch=13')).status).toBe(400)
  })
  it('rejects foreign origins, forged hosts, invalid capabilities and unlisted files', async () => {
    expect((await fetch(`${origin}/api/v1/handshake`, { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect(await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${origin}/api/v1/discovery`, { headers: { Host: 'evil.invalid' } }, (response) => { response.resume(); resolve(response.statusCode) })
      request.on('error', reject); request.end()
    })).toBe(403)
    expect((await fetch(`${origin}/s/wrong/api/v1/songs`)).status).toBe(404)
    expect((await fetch(session + 'secret.txt')).status).toBe(404)
    expect((await fetch(session + 'assets/%2e%2e/secret.txt')).status).toBe(404)
    expect((await fetch(session)).status).toBe(200)
  })
  it('revokes old URLs on stop/restart, including concurrent toggles', async () => {
    const oldPath = new URL(session).pathname
    const [off, on] = await Promise.all([service.setEnabled(false), service.setEnabled(true)])
    expect(off.enabled).toBe(false); expect(on.enabled).toBe(true)
    expect((await fetch(`http://127.0.0.1:${on.port}${oldPath}api/v1/songs`)).status).toBe(404)
  })
})
