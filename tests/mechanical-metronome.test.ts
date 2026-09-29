// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
import { DEFAULT_METRONOME, MetronomeEngine, readMetronome } from '../src/renderer/src/woodshed/metronome-engine.js'

const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
class Parameter {
  setValueAtTime = vi.fn()
  setTargetAtTime = vi.fn()
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}
class Context {
  destination = {}
  get currentTime(): number { return Date.now() / 1000 }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain() { return { gain: new Parameter(), connect: vi.fn(), disconnect: vi.fn() } }
  createOscillator() {
    const source = { frequency: new Parameter(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), type: '', onended: null }
    sources.push(source)
    return source
  }
}
let engine: MetronomeEngine
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.stubGlobal('AudioContext', Context); sources.length = 0; localStorage.clear(); engine = new MetronomeEngine() })
afterEach(() => { engine.destroy(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('mechanical metronome audio clock', () => {
  it('uses exactly spaced audio times and the same timestamps for the pendulum', async () => {
    await engine.start(DEFAULT_METRONOME)
    expect(engine.pulse()).toBeNull()
    vi.advanceTimersByTime(70)
    expect(engine.pulse()).toMatchObject({ beat: 0, time: 0.06, duration: 0.5 })
    vi.advanceTimersByTime(500)
    expect(sources[1]!.start).toHaveBeenCalledWith(0.56)
    expect(engine.pulse()).toMatchObject({ beat: 1, time: 0.56 })
  })
  it('changes tempo while playing and schedules subdivisions between main beats', async () => {
    await engine.start({ ...DEFAULT_METRONOME, subdivision: 2 })
    expect(sources[1]!.start).toHaveBeenCalledWith(0.31)
    engine.update({ ...DEFAULT_METRONOME, bpm: 60, subdivision: 2 })
    vi.advanceTimersByTime(570)
    expect(engine.pulse()).toMatchObject({ bpm: 60, duration: 1 })
    expect(sources[3]!.start).toHaveBeenCalledWith(1.06)
  })
  it('loops a six-beat meter, counts in, and leaves silent training bars unsounded', async () => {
    await engine.start({ ...DEFAULT_METRONOME, beats: 6, denominator: 8, countIn: 1, silentBars: 1 })
    vi.advanceTimersByTime(70)
    expect(engine.pulse()).toMatchObject({ countIn: true, beat: 0 })
    vi.advanceTimersByTime(3000)
    expect(engine.pulse()).toMatchObject({ countIn: false, beat: 0, silent: false })
    vi.advanceTimersByTime(3000)
    expect(engine.pulse()).toMatchObject({ countIn: false, beat: 0, silent: true })
    expect(sources).toHaveLength(12)
  })
  it('accelerates after four bars and cancels all queued sound on stop', async () => {
    await engine.start({ ...DEFAULT_METRONOME, speedStep: 5 })
    vi.advanceTimersByTime(8070)
    expect(engine.pulse()).toMatchObject({ bpm: 125 })
    engine.stop()
    const total = sources.length
    expect(engine.pulse()).toBeNull()
    expect(sources.every(source => source.stop.mock.calls.length >= 2)).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(sources).toHaveLength(total)
  })
  it('does not start after leaving during audio initialization', async () => {
    const starting = engine.start(DEFAULT_METRONOME)
    engine.stop()
    expect(await starting).toBe(false)
    expect(sources).toHaveLength(0)
  })
  it('normalizes corrupt stored preferences', () => {
    localStorage.setItem('bandbuddy.metronome.v1', JSON.stringify({ bpm: 999, beats: -2, subdivision: 20, volume: -8, sound: 'bad' }))
    expect(readMetronome()).toMatchObject({ bpm: 240, beats: 1, subdivision: 4, volume: 0, sound: 'wood' })
  })
})
