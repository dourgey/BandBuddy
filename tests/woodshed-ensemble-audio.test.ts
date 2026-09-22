import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
import { EnsembleAudio } from '../src/renderer/src/woodshed/ensemble-audio.js'
import { ensembleDefaults, type LabEvent } from '../src/renderer/src/woodshed/ensemble.js'
class Param {
  value = 0
  setValueAtTime = vi.fn((v: number) => {
    this.value = v
  })
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}
class Source {
  frequency = new Param()
  detune = new Param()
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
  onended = null
}
const sources: Source[] = []
class Context {
  state = 'running'
  destination = {}
  get currentTime() {
    return Date.now() / 1000
  }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  createGain() {
    return { gain: new Param(), connect: vi.fn(), disconnect: vi.fn() }
  }
  createBiquadFilter() {
    return { frequency: new Param(), Q: new Param(), connect: vi.fn(), disconnect: vi.fn() }
  }
  createOscillator() {
    const s = new Source()
    sources.push(s)
    return s
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sources.length = 0
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const events: LabEvent[] = [
  { beat: 0, duration: 1, midi: 69, velocity: 0.5, step: 0 },
  { beat: 1, duration: 1, midi: 71, velocity: 0.5, step: 1 }
]
describe('ensemble audio lifecycle and shared event clock', () => {
  it('schedules four count-in beats and two finite rounds once each', async () => {
    const audio = new EnsembleAudio(),
      end = vi.fn()
    await audio.play(events, 2, 60, 2, 440, vi.fn(), end)
    await vi.advanceTimersByTimeAsync(8300)
    expect(sources).toHaveLength(8)
    expect(sources.slice(4).map((s) => s.start.mock.calls[0]![0])).toEqual([4.06, 5.06, 6.06, 7.06])
    expect(end).toHaveBeenCalledOnce()
    audio.destroy()
  })
  it('schedules polyphonic piano chords simultaneously and keeps rests silent', async () => {
    const audio = new EnsembleAudio()
    await audio.play(
      [
        { beat: 0, duration: 1, pitches: [48, 60, 64, 67], timbre: 'piano', velocity: 0.6, step: 0 },
        { beat: 1, duration: 1, pitches: [], timbre: 'piano', velocity: 0.6, step: 1 }
      ],
      2,
      120,
      1,
      440,
      vi.fn(),
      vi.fn()
    )
    await vi.advanceTimersByTimeAsync(3200)
    expect(sources).toHaveLength(8)
    expect(sources.slice(4).every((s) => s.start.mock.calls[0]![0] === 2.06)).toBe(true)
    audio.destroy()
  })
  it('stops an infinite loop and clears scheduled voices', async () => {
    const audio = new EnsembleAudio()
    await audio.play(events, 2, 120, 0, 440, vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(3100)
    audio.stop()
    const count = sources.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(sources).toHaveLength(count)
    expect(sources.every((s) => s.stop.mock.calls.length >= 2)).toBe(true)
    audio.destroy()
  })
  it('cancels an in-flight start when the workspace is destroyed', async () => {
    const audio = new EnsembleAudio()
    const promise = audio.preview(69, 440)
    audio.destroy()
    await promise
    expect(sources).toHaveLength(0)
  })
  it('uses sounding frequency and schedules release after the actual gate', async () => {
    const audio = new EnsembleAudio(),
      patch = { ...ensembleDefaults().synth, attack: 2, gate: 0.5, release: 1, lfo: 0 }
    await audio.preview(69, 442, patch)
    expect(sources[0]!.frequency.value).toBe(442)
    expect(sources[0]!.stop).toHaveBeenCalledWith(1.51)
    audio.destroy()
  })
})
