import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/audio-engine.js', () => ({
  setAudioContextOutputDevice: vi.fn(async () => {})
}))

import { WoodshedAudio } from '../src/renderer/src/woodshed/audio.js'
import { EnsembleAudio } from '../src/renderer/src/woodshed/ensemble-audio.js'
import { DEFAULT_EXERCISE } from '../src/renderer/src/woodshed/types.js'
import type { GeneratedExercise } from '../src/renderer/src/woodshed/generator.js'
import type { LabEvent } from '../src/renderer/src/woodshed/ensemble.js'

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
  detune = new Parameter()
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
  constructor() {
    contexts.push(this)
  }
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
  createBiquadFilter() {
    return { frequency: new Parameter(), Q: new Parameter(), connect: vi.fn(), disconnect: vi.fn() }
  }
  createOscillator() {
    const source = new Source()
    sources.push(source)
    return source
  }
}

const animations = new Map<number, FrameRequestCallback>()
let nextAnimation = 0
const runAnimation = () => {
  const pending = [...animations.values()]
  animations.clear()
  pending.forEach((callback) => callback(Date.now()))
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
const events: LabEvent[] = [
  { beat: 0, duration: 1, midi: 69, velocity: 0.5, step: 0 },
  { beat: 1, duration: 1, midi: 71, velocity: 0.5, step: 1 }
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sources.length = 0
  contexts.length = 0
  animations.clear()
  nextAnimation = 0
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextAnimation
    animations.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => animations.delete(id)))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('woodshed background audio lifecycle', () => {
  it('keeps scheduling exact notes with no visual RAF or growing cue backlog, then restores only the latest cue', async () => {
    const audio = new WoodshedAudio()
    const onFrame = vi.fn()
    audio.onFrame(onFrame)
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 0, subdivision: 1 })
    await vi.advanceTimersByTimeAsync(700)
    runAnimation()
    const stop = vi.spyOn(audio, 'stop')
    audio.setVisualActive(false)
    onFrame.mockClear()
    const initialSources = sources.length
    await vi.advanceTimersByTimeAsync(10000)

    expect(animations.size).toBe(0)
    expect(onFrame).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(contexts[0]!.close).not.toHaveBeenCalled()
    expect(sources.length).toBeGreaterThan(initialSources)
    expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true)
    expect((audio as unknown as { queue: unknown[] }).queue.length).toBeLessThanOrEqual(4)
    const melody = sources.filter((source) => source.frequency.value > 250 && source.frequency.value < 350)
    melody.forEach((source, i) => expect(source.start.mock.calls[0]![0]).toBeCloseTo(0.06 + i * 0.5, 5))
    const latest = audio.getFrame()
    expect(latest).toMatchObject({ playing: true, eventId: 'e1', round: 6 })

    const sourceCount = sources.length
    audio.setVisualActive(true)
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(latest)
    expect(sources).toHaveLength(sourceCount)
    expect(animations.size).toBe(1)
    audio.setVisualActive(true)
    expect(animations.size).toBe(1)
    audio.destroy()
  })

  it('delivers a terminal frame and releases its timer when a finite exercise ends while hidden', async () => {
    const audio = new WoodshedAudio()
    const onFrame = vi.fn()
    audio.onFrame(onFrame)
    audio.setVisualActive(false)
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 1, subdivision: 1 })
    onFrame.mockClear()
    await vi.advanceTimersByTimeAsync(2200)

    expect(onFrame).toHaveBeenCalledOnce()
    expect(onFrame.mock.calls[0]![0]).toMatchObject({ playing: false, eventId: null })
    expect(audio.getFrame()).toMatchObject({ playing: false })
    expect(animations.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(contexts[0]!.close).not.toHaveBeenCalled()
    audio.setVisualActive(true)
    expect(animations.size).toBe(0)
    audio.destroy()
  })

  it('pauses a hidden exercise at the latest audio position and still reports playing false', async () => {
    const audio = new WoodshedAudio()
    const onFrame = vi.fn()
    audio.onFrame(onFrame)
    audio.setVisualActive(false)
    await audio.play(exercise, { ...DEFAULT_EXERCISE, bpm: 120, countIn: 0, rounds: 0 })
    await vi.advanceTimersByTimeAsync(1200)
    audio.pause()
    expect(onFrame.mock.lastCall![0]).toMatchObject({ playing: false, eventId: 'e2', beat: 2 })
    expect(vi.getTimerCount()).toBe(0)
    audio.destroy()
  })
})

describe('ensemble background audio lifecycle', () => {
  it('keeps the audio scheduler running while hidden and resumes with one current cue', async () => {
    const audio = new EnsembleAudio()
    const onFrame = vi.fn()
    const onEnd = vi.fn()
    await audio.play(events, 2, 120, 0, 440, onFrame, onEnd)
    await vi.advanceTimersByTimeAsync(2500)
    runAnimation()
    const stop = vi.spyOn(audio, 'stop')
    audio.setVisualActive(false)
    onFrame.mockClear()
    await vi.advanceTimersByTimeAsync(10000)

    expect(animations.size).toBe(0)
    expect(onFrame).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(contexts[0]!.close).not.toHaveBeenCalled()
    expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true)
    expect((audio as unknown as { visualQueue: unknown[] }).visualQueue.length).toBeLessThanOrEqual(1)
    sources.slice(4).forEach((source, i) => expect(source.start.mock.calls[0]![0]).toBeCloseTo(2.06 + i * 0.5, 5))

    const sourceCount = sources.length
    audio.setVisualActive(true)
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(events[0], 11, 0)
    expect(sources).toHaveLength(sourceCount)
    expect(animations.size).toBe(1)
    audio.destroy()
  })

  it('finishes once in the audio timer without relying on any animation callback', async () => {
    const audio = new EnsembleAudio()
    const onFrame = vi.fn()
    const onEnd = vi.fn()
    audio.setVisualActive(false)
    await audio.play(events, 2, 120, 1, 440, onFrame, onEnd)
    await vi.advanceTimersByTimeAsync(3300)

    expect(sources).toHaveLength(6)
    expect(onFrame).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledOnce()
    expect(animations.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(contexts[0]!.close).not.toHaveBeenCalled()
    audio.setVisualActive(true)
    expect(onFrame).not.toHaveBeenCalled()
    expect(animations.size).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onEnd).toHaveBeenCalledOnce()
    audio.destroy()
  })

  it('releases its timer and creates no RAF when an empty sequence ends during scheduling', async () => {
    const audio = new EnsembleAudio()
    const onEnd = vi.fn()
    audio.setVisualActive(false)
    await audio.play([], 2, 120, 1, 440, vi.fn(), onEnd)
    await vi.advanceTimersByTimeAsync(2100)
    expect(onEnd).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(animations.size).toBe(0)
    audio.destroy()
  })
})
