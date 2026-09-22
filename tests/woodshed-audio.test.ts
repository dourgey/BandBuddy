import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
import { WoodshedAudio } from '../src/renderer/src/woodshed/audio.js'
import { DEFAULT_EXERCISE } from '../src/renderer/src/woodshed/types.js'
import type { GeneratedExercise } from '../src/renderer/src/woodshed/generator.js'
class Parameter {
  value = 0
  setValueAtTime = vi.fn((value: number) => {
    this.value = value
  })
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}
class Source {
  frequency = new Parameter()
  type = ''
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
  onended: (() => void) | null = null
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
    return { gain: new Parameter(), connect: vi.fn(), disconnect: vi.fn() }
  }
  createOscillator() {
    const source = new Source()
    sources.push(source)
    return source
  }
}
const exercise: GeneratedExercise = {
  events: [0, 1, 2, 3].map((beat) => ({
    id: `e${beat}`,
    beat,
    duration: 1,
    notes: [{ string: 1, fret: beat, midi: 60 + beat }]
  })),
  beats: 4,
  bars: 1
}
beforeEach(() => {
  sources.length = 0
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const melody = () => sources.filter((s) => s.frequency.value < 350 && s.frequency.value > 250)
describe('woodshed audio clock and lifecycle', () => {
  it('schedules notes on the audio clock at exact beat intervals across two rounds', async () => {
    const audio = new WoodshedAudio()
    const frames: unknown[] = []
    audio.onFrame((f) => frames.push(f))
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 2, subdivision: 1 })
    await vi.advanceTimersByTimeAsync(4100)
    const notes = melody()
    expect(notes).toHaveLength(8)
    notes.forEach((n, i) => expect(n.start.mock.calls[0]![0]).toBeCloseTo(0.06 + i * 0.5, 5))
    expect(frames.at(-1)).toMatchObject({ playing: false })
    audio.destroy()
  })
  it('pauses, resumes without replaying earlier notes, and cancels sources on stop', async () => {
    const audio = new WoodshedAudio()
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 1, subdivision: 1 })
    await vi.advanceTimersByTimeAsync(700)
    audio.pause()
    const count = melody().length
    await vi.advanceTimersByTimeAsync(1000)
    expect(melody()).toHaveLength(count)
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 1, subdivision: 1 }, false, true)
    await vi.advanceTimersByTimeAsync(1400)
    expect(melody()).toHaveLength(4)
    audio.stop()
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true)
    audio.destroy()
  })
  it('limits playback to requested measures and increments speed per round', async () => {
    const twoBars = {
      ...exercise,
      beats: 8,
      bars: 2,
      events: [...exercise.events, ...exercise.events.map((e) => ({ ...e, id: e.id + 'b', beat: e.beat + 4 }))]
    }
    const audio = new WoodshedAudio()
    await audio.play(twoBars, {
      ...DEFAULT_EXERCISE,
      bpm: 120,
      speedStep: 10,
      countIn: 0,
      rounds: 2,
      loopStart: 2,
      loopEnd: 2,
      subdivision: 1
    })
    await vi.advanceTimersByTimeAsync(4100)
    const notes = melody()
    expect(notes).toHaveLength(8)
    expect(notes[4]!.start.mock.calls[0]![0]).toBeCloseTo(2.06, 5)
    expect(notes[5]!.start.mock.calls[0]![0]).toBeCloseTo(2.06 + 60 / 130, 5)
    audio.destroy()
  })
  it('does not emit demonstration pitches in follow mode', async () => {
    const audio = new WoodshedAudio()
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 1, mode: 'follow' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(melody()).toHaveLength(0)
    audio.destroy()
  })
  it('hides beat and event cues for silent measures', async () => {
    const twoBars = {
      ...exercise,
      beats: 8,
      bars: 2,
      events: [...exercise.events, ...exercise.events.map((e) => ({ ...e, id: e.id + 'b', beat: e.beat + 4 }))]
    }
    const audio = new WoodshedAudio()
    const frames: { bar: number; hidden: boolean }[] = []
    audio.onFrame((f) => {
      if (f.playing) frames.push(f)
    })
    await audio.play(twoBars, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 1, silentBars: 1, mode: 'follow' })
    await vi.advanceTimersByTimeAsync(3900)
    expect(frames.filter((f) => f.bar === 2).every((f) => f.hidden)).toBe(true)
    expect(frames.some((f) => f.bar === 1 && !f.hidden)).toBe(true)
    audio.destroy()
  })
  it('cannot start late after destruction during asynchronous initialization', async () => {
    const audio = new WoodshedAudio()
    const pending = audio.play(exercise, DEFAULT_EXERCISE)
    audio.destroy()
    await expect(pending).rejects.toThrow('关闭')
    expect(sources).toHaveLength(0)
  })
})
