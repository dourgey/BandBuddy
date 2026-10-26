// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanPlayer } from '../src/renderer/src/lan/player.js'
import { LAN_PCM_HEADER, LAN_PCM_MAGIC, type LanSong } from '@shared/lan.js'

class Param {
  setValueAtTime = vi.fn()
  linearRampToValueAtTime = vi.fn()
  setTargetAtTime = vi.fn()
  cancelScheduledValues = vi.fn()
}
class Node {
  gain = new Param()
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  connect = vi.fn(() => this)
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
class Context {
  static latest: Context
  currentTime = 0
  sampleRate = 48000
  destination = {}
  sources: Node[] = []
  gains: Node[] = []
  resume = vi.fn(async (): Promise<void> => undefined)
  close = vi.fn(async () => undefined)
  constructor() { Context.latest = this }
  createBuffer(channels: number, frames: number, rate: number): unknown {
    const data = Array.from({ length: channels }, () => new Float32Array(frames))
    return { duration: frames / rate, getChannelData: (channel: number) => data[channel] }
  }
  createBufferSource(): Node { const n = new Node(); this.sources.push(n); return n }
  createGain(): Node { const n = new Node(); this.gains.push(n); return n }
}
class Socket {
  static OPEN = 1
  static latest: Socket
  readyState = 1
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: Array<Record<string, unknown>> = []
  constructor() { Socket.latest = this }
  send(value: string): void { this.sent.push(JSON.parse(value)) }
  close = vi.fn()
  event(data: unknown): void { this.onmessage?.({ data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }) }
  config(): Record<string, unknown> { return this.sent.filter(m => m.type === 'configure').at(-1)! }
  ready(): void { this.event({ type: 'ready', generation: this.config().generation }) }
  packet(sequence: number, position: number, rate = 1, generation = this.config().generation as number, last = false): void {
    const data = new ArrayBuffer(LAN_PCM_HEADER + 960 * 8), v = new DataView(data)
    v.setUint32(0, LAN_PCM_MAGIC, true); v.setUint32(4, generation, true); v.setUint32(8, sequence, true)
    v.setUint32(12, 960, true); v.setFloat64(16, position, true); v.setFloat64(24, rate, true)
    v.setUint32(32, 48000, true); v.setUint32(36, last ? 1 : 0, true)
    new Float32Array(data, LAN_PCM_HEADER).fill(.1)
    this.event(data)
  }
}
const song = { id: '11111111-1111-4111-8111-111111111111', durationMs: 20000,
  stems: [{ defaultVisible: true }] } as LanSong
let player: LanPlayer
async function load(): Promise<Socket> {
  const promise = player.load(song, new URL('http://192.168.0.2:60232/'), 0, new AbortController().signal)
  const socket = Socket.latest
  socket.onopen?.(); socket.ready(); await promise
  return socket
}
async function start(): Promise<Socket> {
  const socket = await load()
  await player.play(); socket.ready()
  for (let i = 0; i < 20; i++) socket.packet(i, i * .02)
  return socket
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('AudioContext', Context); vi.stubGlobal('WebSocket', Socket)
  player = new LanPlayer()
})
afterEach(() => { player.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('bounded browser PCM playback', () => {
  it('connects without downloading or decoding a whole audio file', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const socket = await load()
    expect(fetch).not.toHaveBeenCalled()
    expect(socket.config()).toMatchObject({ playing: false, rate: 1, pitch: 0 })
    expect(socket.sent.some(m => m.type === 'pull')).toBe(false)
  })
  it('primes before playing, limits credit and derives time from the audio clock', async () => {
    const socket = await load(), buffering = vi.fn(); player.onBuffering = buffering
    await player.play(); socket.ready()
    expect(socket.sent.at(-1)).toMatchObject({ type: 'pull', count: 20 })
    for (let i = 0; i < 7; i++) socket.packet(i, i * .02)
    expect(Context.latest.gains).toHaveLength(0)
    socket.packet(7, .14)
    expect(Context.latest.gains).toHaveLength(8)
    const startAt = Context.latest.sources.at(-8)!.start.mock.calls[0]![0] as number
    Context.latest.currentTime = startAt + .065
    const time = vi.fn(); player.onTime = time; vi.advanceTimersByTime(25)
    expect(time.mock.calls.at(-1)![0]).toBeCloseTo(.065, 8)
    expect(buffering).toHaveBeenLastCalledWith(false)
    expect(socket.sent.filter(m => m.type === 'pull').reduce((n, m) => n + (m.count as number), 0)).toBeLessThanOrEqual(24)
  })
  it('seeks immediately and rejects old PCM even when it arrives later', async () => {
    const socket = await start(), old = socket.config().generation as number
    const sources = Context.latest.sources.filter(s => s.buffer?.duration === .02)
    player.seek(10)
    expect(sources.every(s => s.stop.mock.calls.length === 1)).toBe(true)
    expect(socket.config()).toMatchObject({ position: 10, playing: true })
    const count = Context.latest.sources.length
    socket.packet(20, .4, 1, old)
    expect(Context.latest.sources).toHaveLength(count)
    socket.ready(); for (let i = 0; i < 8; i++) socket.packet(i, 10 + i * .02)
    expect(Context.latest.sources.length).toBe(count + 8)
  })
  it('prepares new transforms while old PCM keeps playing, then crossfades', async () => {
    const socket = await start(), sources = Context.latest.sources.filter(s => s.buffer?.duration === .02)
    Context.latest.currentTime = .1
    await player.setTransform(1.5, 2)
    expect(sources.every(s => s.stop.mock.calls.length === 0)).toBe(true)
    expect(socket.config()).toMatchObject({ position: .39, rate: 1.5, pitch: 2 })
    socket.ready(); for (let i = 0; i < 8; i++) socket.packet(i, .39 + i * .03, 1.5)
    expect(Context.latest.gains.at(-9)!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, expect.any(Number))
    expect(Context.latest.gains.at(-8)!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, expect.any(Number))
  })
  it('freezes at the last consumed frame on underrun instead of advancing silently', async () => {
    const socket = await start(), time = vi.fn(), buffering = vi.fn()
    player.onTime = time; player.onBuffering = buffering
    Context.latest.currentTime = 2; vi.advanceTimersByTime(25)
    expect(time).toHaveBeenLastCalledWith(expect.closeTo(.4, 8))
    expect(buffering).toHaveBeenLastCalledWith(true)
    Context.latest.currentTime = 4; vi.advanceTimersByTime(25)
    expect(time).toHaveBeenLastCalledWith(expect.closeTo(.4, 8))
    expect(socket.sent.some(m => m.type === 'pull')).toBe(true)
  })
  it('uses packet timestamps across loop wraps', async () => {
    const socket = await load(); player.setLoop({ start: 1, end: 1.2 }); await player.play(); socket.ready()
    for (let i = 0; i < 20; i++) socket.packet(i, 1 + i % 10 * .02)
    const first = Context.latest.sources.find(s => s.buffer?.duration === .02)!
    Context.latest.currentTime = (first.start.mock.calls[0]![0] as number) + .25
    const time = vi.fn(); player.onTime = time; vi.advanceTimersByTime(25)
    expect(time.mock.calls.at(-1)![0]).toBeCloseTo(1.05, 8)
  })
  it('sends mix controls without flushing PCM or replacing the stream generation', async () => {
    const socket = await start(), generation = socket.config().generation
    player.mix([{ gain: .7, muted: false, solo: true, visible: true }])
    vi.advanceTimersByTime(60)
    expect(socket.config().generation).toBe(generation)
    expect(socket.sent.at(-1)).toMatchObject({ type: 'mix', generation, mix: [{ gain: .7, solo: true }] })
    expect(Context.latest.sources.filter(s => s.buffer?.duration === .02).every(s => s.stop.mock.calls.length === 0)).toBe(true)
  })
  it('cancels a pending resume and stops stale audio on disconnect', async () => {
    const socket = await load()
    let resume!: () => void
    Context.latest.resume.mockImplementation(() => new Promise<void>(resolve => { resume = resolve }))
    const pending = player.play(); player.pause(); resume(); await pending
    expect(socket.config().playing).toBe(false)
    Context.latest.resume.mockImplementation(async () => undefined)
    await player.play(); socket.ready(); for (let i = 0; i < 8; i++) socket.packet(i, i * .02)
    const error = vi.fn(); player.onError = error; socket.onclose?.()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('连接已断开'))
    expect(Context.latest.sources.filter(s => s.buffer?.duration === .02).every(s => s.stop.mock.calls.length === 1)).toBe(true)
  })
})
