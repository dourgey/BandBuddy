import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
import { DrumAudio } from '../src/renderer/src/sample-drums/drum-audio.js'
import { presetDraft, type DrumSample } from '../src/renderer/src/sample-drums/drum-patterns.js'
import { setAudioContextOutputDevice } from '../src/renderer/src/audio-engine.js'

class Source {
  buffer = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
  onended: (() => void) | null = null
}
const sources: Source[] = []
const contexts: Context[] = []
class Context {
  state = 'running'
  destination = {}
  constructor() { contexts.push(this) }
  get currentTime() { return Date.now() / 1000 }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain() { return { gain: { value: 0, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
  createBufferSource() { const source = new Source(); sources.push(source); return source }
  decodeAudioData = vi.fn(async () => ({} as AudioBuffer))
}
const sample = (note: number): DrumSample => ({ midiNote: note, file: `${note}.flac`, nameZh: String(note), articulation: '' })
beforeEach(() => {
  sources.length = 0; contexts.length = 0
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(0)
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })))
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('sample audio scheduling and lifecycle', () => {
  it('schedules exact beat times over loop boundaries and resumes at the requested step', async () => {
    const audio = new DrumAudio()
    const draft = presetDraft()
    draft.tracks = [draft.tracks[0]!]
    const cursor = vi.fn()
    await audio.play(() => draft, [sample(36)], 'http://local/', cursor)
    await vi.advanceTimersByTimeAsync(2050)
    expect(sources.map(source => source.start.mock.calls[0]![0])).toEqual([0.045, 1.045, 2.045])
    expect(cursor).toHaveBeenCalledWith(0)
    expect(cursor).toHaveBeenCalledWith(8)
    audio.stop()
    const stoppedCount = sources.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(sources).toHaveLength(stoppedCount)
    expect(sources.every(source => source.stop.mock.calls.length > 0)).toBe(true)
    await audio.play(() => draft, [sample(36)], 'http://local/', cursor, 8)
    expect(sources.at(-1)!.start.mock.calls[0]![0]).toBeCloseTo(4.095)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    audio.destroy()
  })
  it('does not start a pending playback or pad strike after stop or destroy', async () => {
    let release!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { release = resolve })))
    const audio = new DrumAudio()
    const play = audio.play(presetDraft, [sample(36)], 'http://local/', vi.fn())
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    audio.stop()
    release({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })
    expect(await play).toBe(false)
    expect(sources).toHaveLength(0)
    const hit = audio.hit(sample(38), 'http://local/', 0.7, 0.8)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    audio.destroy()
    release({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })
    await hit
    expect(sources).toHaveLength(0)
    expect(contexts[0]!.close).toHaveBeenCalledOnce()
  })
  it('deduplicates concurrent sample loads and allows retry after a network error', async () => {
    const audio = new DrumAudio()
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response)
    await expect(audio.load([sample(38)], 'http://local/')).rejects.toThrow('无法载入音色')
    await Promise.all([audio.load([sample(38)], 'http://local/'), audio.load([sample(38)], 'http://local/')])
    expect(fetch).toHaveBeenCalledTimes(2)
    await audio.setOutput('device-2')
    await audio.hit(sample(38), 'http://local/', 0.7, 0.8)
    expect(setAudioContextOutputDevice).toHaveBeenLastCalledWith(contexts[0], 'device-2')
    expect(sources).toHaveLength(1)
    audio.destroy()
  })
  it('chokes open hats and cymbal tails on their closing articulation', async () => {
    const audio = new DrumAudio()
    await audio.hit(sample(33), 'http://local/', 0.7, 0.8)
    await audio.hit(sample(42), 'http://local/', 0.7, 0.8)
    expect(sources[0]!.stop).toHaveBeenCalledWith(0)
    await audio.hit(sample(49), 'http://local/', 0.7, 0.8)
    await audio.hit(sample(66), 'http://local/', 0.7, 0.8)
    expect(sources[2]!.stop).toHaveBeenCalledWith(0)
    audio.destroy()
  })
})
