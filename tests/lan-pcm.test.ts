import { existsSync } from 'node:fs'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import WebSocket from 'ws'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { LanPcmRenderer } from '../src/main/lan-pcm.js'
import { validPcmConfig } from '../src/main/lan-stream.js'
import { LanService } from '../src/main/lan.js'
import { runProcess } from '../src/main/process.js'
import { createDefaultPracticeState } from '@shared/domain.js'
import { LAN_PCM_HEADER, LAN_PCM_MAGIC, type LanPcmConfig } from '@shared/lan.js'

const ffmpeg = path.resolve('resources/bin/ffmpeg.exe')
const executable = path.resolve('resources/audio-host/win32-x64/bandbuddy-audio-host.exe')
const available = existsSync(ffmpeg) && existsSync(executable)
const songId = '11111111-1111-4111-8111-111111111111'
const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
const mix = [{ gain: 1, muted: false, solo: false, visible: true }, { gain: 1, muted: false, solo: false, visible: true }]
function config(generation: number, overrides: Partial<LanPcmConfig> = {}): LanPcmConfig {
  return { type: 'configure', generation, songId, position: 0, rate: 1, pitch: 0, playing: true, mix, loop: null, ...overrides }
}
function amplitude(pcm: Buffer, hz: number, channel = 0): number {
  // Analyse the steady-state middle second; ignore algorithm/start/end transients.
  const start = 12000, count = Math.min(48000, pcm.length / 8 - start)
  let real = 0, imaginary = 0
  for (let f = 0; f < count; f++) {
    const sample = pcm.readFloatLE((start + f) * 8 + channel * 4), angle = 2 * Math.PI * hz * f / 48000
    real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
  }
  return Math.hypot(real, imaginary) * 2 / count
}

it('rejects malformed, unbounded and non-finite remote controls', () => {
  expect(validPcmConfig(config(1))).toBe(true)
  for (const change of [{ rate: NaN }, { rate: 3 }, { generation: -1 }, { pitch: .5 }, { position: Infinity },
    { loop: { start: 2, end: 1 } }, { mix: [{ gain: 100, muted: false, solo: false, visible: true }] }]) {
    expect(validPcmConfig(config(1, change))).toBe(false)
  }
})

describe.skipIf(!available)('real continuous native PCM and WebSocket sessions', () => {
  let root: string
  let files: string[]
  let service: LanService
  let base: string
  let metadata: unknown
  let song: Record<string, unknown>
  const clients = new Set<WebSocket>()
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bandbuddy-pcm-'))
    files = [path.join(root, '吉他.wav'), path.join(root, '鼓.wav')]
    await mkdir(path.join(root, 'assets'))
    await writeFile(path.join(root, 'lan.html'), '<html></html>')
    for (const [i, file] of files.entries()) {
      const hz = i ? 220 : 440
      const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
        `aevalsrc=0.2*sin(2*PI*${hz}*t)|0.1*sin(2*PI*${hz * 1.5}*t):s=48000:d=3`, '-c:a', 'pcm_f32le', file])
      expect(result.code, result.stderr).toBe(0)
    }
    song = { id: songId, status: 'ready', title: 'PCM 测试', artist: 'Band', durationMs: 3000, updatedAt: '', sourceFormat: 'existing-stems',
      practice: createDefaultPracticeState(songId), stemTypes: ['guitar', 'drums'], lyrics: null, bpm: 120, musicalKey: null,
      artworkUrl: null, videoUrl: null,
      stems: ids.map((id, i) => ({ id, type: i ? 'drums' : 'guitar', name: i ? '鼓' : '吉他', sampleRate: 48000, channels: 2, durationMs: 3000, encodingGain: 1, peaksUrl: null })) }
    service = new LanService({ getSong: (id: string) => id === songId ? song : null, listSongs: () => [song],
      getSettings: () => ({ appearance: {} }) } as never,
    { tool: async () => ffmpeg, resolveProtocolPath: (url: URL) => files[ids.indexOf(url.pathname.split('/').at(-1)!)] ?? null } as never,
    { audioHostExecutable: () => executable } as never, { warn: vi.fn() } as never, root, 0)
    const status = await service.setEnabled(true)
    const origin = `http://127.0.0.1:${status.port}`
    const handshake = await (await fetch(`${origin}/api/v1/handshake`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'bandbuddy-lan', version: 1, platform: 'desktop' }) })).json()
    base = origin + handshake.basePath
    metadata = await (await fetch(`${base}api/v2/songs/${songId}/playback`)).json()
  })
  afterAll(async () => {
    for (const ws of clients) ws.terminate()
    await service?.stop(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  })
  async function renderer(rate: number, pitch: number, position = 0, duration = 3): Promise<LanPcmRenderer> {
    return LanPcmRenderer.create(ffmpeg, executable, files.map((file, i) => ({ path: file, drums: Boolean(i), gain: .5 })), position, duration, rate, pitch, new AbortController().signal)
  }
  async function collect(r: LanPcmRenderer): Promise<Buffer> {
    const chunks: Buffer[] = []
    try { for (;;) { const next = await r.next(); if (!next) break; chunks.push(next.pcm) } }
    finally { r.dispose() }
    return Buffer.concat(chunks)
  }
  it('mixes stereo PCM sample-accurately without a WAV or MP3 render', async () => {
    const pcm = await collect(await renderer(1, 0))
    expect(pcm.length).toBe(3 * 48000 * 8)
    for (let f = 0; f < 48000; f += 13) {
      expect(pcm.readFloatLE(f * 8)).toBeCloseTo(.1 * Math.sin(2 * Math.PI * 440 * f / 48000) + .1 * Math.sin(2 * Math.PI * 220 * f / 48000), 5)
      expect(pcm.readFloatLE(f * 8 + 4)).toBeCloseTo(.05 * Math.sin(2 * Math.PI * 660 * f / 48000) + .05 * Math.sin(2 * Math.PI * 330 * f / 48000), 5)
    }
  })
  it('changes tempo without changing drum pitch and shifts only harmonic audio', async () => {
    const pcm = await collect(await renderer(1.5, 12))
    expect(pcm.length).toBe(2 * 48000 * 8)
    expect(amplitude(pcm, 880)).toBeGreaterThan(.04)
    expect(amplitude(pcm, 220)).toBeGreaterThan(.04)
    expect(amplitude(pcm, 440)).toBeLessThan(.02)
    expect(Math.max(...[-1, -.5, 0, .5, 1].map(offset => amplitude(pcm, 1320 + offset, 1)))).toBeGreaterThan(.02)
    expect(amplitude(pcm, 330, 1)).toBeGreaterThan(.02)
    const slowed = await collect(await renderer(.75, 0))
    expect(slowed.length).toBe(4 * 48000 * 8)
    expect(amplitude(slowed, 440)).toBeGreaterThan(.04)
    expect(amplitude(slowed, 220)).toBeGreaterThan(.04)
  })
  it('starts at the requested song frame and preserves exact final length', async () => {
    const pcm = await collect(await renderer(1, 0, .501, .623))
    expect(pcm.length).toBe(Math.ceil((.623 - .501) * 48000) * 8)
    expect(pcm.readFloatLE(0)).toBeCloseTo(.1 * Math.sin(2 * Math.PI * 440 * .501) + .1 * Math.sin(2 * Math.PI * 220 * .501), 5)
  })
  async function connect(): Promise<{ socket: WebSocket; events: Array<Record<string, unknown>>; packets: Buffer[] }> {
    const socket = new WebSocket(base.replace('http:', 'ws:') + 'api/v1/pcm')
    clients.add(socket)
    const events: Array<Record<string, unknown>> = [], packets: Buffer[] = []
    socket.on('message', (data, binary) => binary ? packets.push(Buffer.from(data as Buffer)) : events.push(JSON.parse(data.toString())))
    await once(socket, 'open')
    return { socket, events, packets }
  }
  async function until(predicate: () => boolean): Promise<void> {
    await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 6000, interval: 10 })
  }
  it('returns lightweight playback metadata and preserves verified download manifests', async () => {
    expect(metadata).toMatchObject({ stems: [{ audio: { sha256: '' } }, { audio: { sha256: '' } }] })
    const manifest = await (await fetch(`${base}api/v2/songs/${songId}/manifest`)).json()
    expect(manifest.stems[0].audio.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('requires session authorization and rejects another browser origin', async () => {
    for (const url of [new URL('/api/v1/pcm', base).href.replace('http:', 'ws:'), base.replace('http:', 'ws:') + 'api/v1/pcm']) {
      const socket = new WebSocket(url, { origin: 'http://untrusted.example' })
      socket.on('error', () => undefined)
      const [response] = await once(socket, 'unexpected-response')
      expect(response).toBeDefined(); socket.terminate()
    }
  })
  it('sends only requested PCM and drops previous generations during seek and rapid changes', async () => {
    const a = await connect()
    a.socket.send(JSON.stringify(config(1)))
    await until(() => a.events.some(e => e.type === 'ready'))
    expect(a.packets).toHaveLength(0)
    a.socket.send(JSON.stringify({ type: 'pull', generation: 1, count: 3 }))
    await until(() => a.packets.length === 3)
    for (const packet of a.packets) { expect(packet.readUInt32LE(0)).toBe(LAN_PCM_MAGIC); expect(packet.length).toBe(LAN_PCM_HEADER + 960 * 8) }
    a.socket.send(JSON.stringify(config(2, { rate: .5, pitch: 12 })))
    a.socket.send(JSON.stringify(config(3, { position: 1, pitch: -5 })))
    await until(() => a.events.some(e => e.type === 'ready' && e.generation === 3))
    const boundary = a.packets.length
    a.socket.send(JSON.stringify({ type: 'pull', generation: 3, count: 2 }))
    await until(() => a.packets.length === boundary + 2)
    expect(a.packets.slice(boundary).every(p => p.readUInt32LE(4) === 3)).toBe(true)
    expect(a.packets[boundary]!.readDoubleLE(16)).toBe(1)
    expect(a.events.some(e => e.type === 'error')).toBe(false)
    a.socket.close()
  })
  it('keeps device mixes independent and loops with explicit source timestamps', async () => {
    const a = await connect(), b = await connect()
    a.socket.send(JSON.stringify(config(1, { position: .2, loop: { start: .2, end: .34 } })))
    b.socket.send(JSON.stringify(config(1, { mix: mix.map(m => ({ ...m, gain: 0 })) })))
    await until(() => a.events.some(e => e.type === 'ready') && b.events.some(e => e.type === 'ready'))
    a.socket.send(JSON.stringify({ type: 'pull', generation: 1, count: 20 }))
    b.socket.send(JSON.stringify({ type: 'pull', generation: 1, count: 20 }))
    await until(() => a.packets.length === 20 && b.packets.length === 20)
    expect(a.packets.filter(p => p.readDoubleLE(16) === .2).length).toBeGreaterThan(1)
    expect(a.packets.every(p => p.readDoubleLE(16) < .34)).toBe(true)
    expect(b.packets.every(p => p.subarray(LAN_PCM_HEADER).every(byte => byte === 0))).toBe(true)
    a.socket.close(); b.socket.close()
  })
  it('updates mute/solo/gain in the same continuous decoder session', async () => {
    const a = await connect()
    a.socket.send(JSON.stringify(config(1)))
    await until(() => a.events.some(e => e.type === 'ready'))
    a.socket.send(JSON.stringify({ type: 'pull', generation: 1, count: 4 }))
    await until(() => a.packets.length === 4)
    a.socket.send(JSON.stringify({ type: 'mix', generation: 1, mix: mix.map(m => ({ ...m, muted: true })) }))
    a.socket.send(JSON.stringify({ type: 'pull', generation: 1, count: 4 }))
    await until(() => a.packets.length === 8)
    expect(a.events.filter(e => e.type === 'ready')).toHaveLength(1)
    expect(a.packets[7]!.subarray(LAN_PCM_HEADER).every(byte => byte === 0)).toBe(true)
    expect(a.packets[7]!.readDoubleLE(16)).toBeCloseTo(.14)
    a.socket.close()
  })
  it('closes sessions immediately when LAN mode stops', async () => {
    const a = await connect()
    const closed = once(a.socket, 'close')
    await service.stop(); await closed
    expect(a.socket.readyState).toBe(WebSocket.CLOSED)
  })
})
