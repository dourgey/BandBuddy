import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureDetail, fixtureRehearsal, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { buildRehearsalTimeline } from '../packages/shared/src/rehearsal.js'

const audioHarness = vi.hoisted(() => ({
  instances: [] as Array<{ play: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
  clicks: [] as number[]
}))

vi.mock('../src/renderer/src/audio-engine.js', () => {
  class FakeMultiTrackAudioEngine {
    onTime = vi.fn()
    onEnded = vi.fn()
    load = vi.fn().mockResolvedValue(undefined)
    applyPractice = vi.fn()
    seek = vi.fn()
    play = vi.fn().mockResolvedValue(true)
    pause = vi.fn()
    destroy = vi.fn()

    constructor() {
      audioHarness.instances.push(this)
    }
  }

  return { MultiTrackAudioEngine: FakeMultiTrackAudioEngine }
})

import { RehearsalAudioEngine } from '../src/renderer/src/rehearsal-audio-engine.js'

class FakeGainNode {
  gain = { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
  connect(): this { return this }
  disconnect(): void {}
}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createGain(): FakeGainNode { return new FakeGainNode() }
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: () => new FakeGainNode(),
      start: () => audioHarness.clicks.push(performance.now()),
      stop: vi.fn()
    }
  }
  close(): Promise<void> { return Promise.resolve() }
  resume(): Promise<void> { return Promise.resolve() }
}

function playbackConfiguration() {
  const song = fixtureDetail(fixtureSongs[0]!)
  song.stems = song.stems.map((stem) => ({ ...stem, mediaUrl: `bandbuddy-media://song/${stem.id}` }))
  return {
    timeline: buildRehearsalTimeline([fixtureRehearsal.items[0]!], [song]),
    songs: [song],
    recordingTracks: [],
    recordingTakes: [],
    outputDeviceId: '',
    latencyMode: 'interactive' as const
  }
}

describe('RehearsalAudioEngine playback startup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    audioHarness.instances.length = 0
    audioHarness.clicks.length = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('Audio', class { load = vi.fn(); removeAttribute = vi.fn() })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('restarts the active song when rehearsal playback resumes', async () => {
    const engine = new RehearsalAudioEngine()
    await engine.configure(playbackConfiguration())

    await engine.play()
    engine.pause()
    await engine.play()

    expect(audioHarness.instances[0]?.play).toHaveBeenCalledTimes(2)
    expect(engine.isPlaying).toBe(true)
    engine.destroy()
  })

  it('waits for an in-flight preparation before reporting playback as started', async () => {
    const engine = new RehearsalAudioEngine()
    await engine.configure(playbackConfiguration())
    const songEngine = audioHarness.instances[0]!
    let resolveFirstLoad: (() => void) | undefined
    songEngine.load.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstLoad = resolve }))

    const firstStart = engine.play()
    const latestStart = engine.play()
    resolveFirstLoad?.()
    await Promise.all([firstStart, latestStart])

    expect(songEngine.play).toHaveBeenCalledTimes(1)
    expect(engine.isPlaying).toBe(true)
    engine.destroy()
  })

  it('advances hidden playback with a timer, throttles background time updates, and restores the current position immediately', async () => {
    const engine = new RehearsalAudioEngine()
    const onTime = vi.fn()
    engine.onTime(onTime)
    await engine.configure(playbackConfiguration())
    await engine.play()
    const songEngine = audioHarness.instances[0]!
    const previousPauses = songEngine.pause.mock.calls.length
    engine.setVisualActive(false)
    onTime.mockClear()
    vi.mocked(requestAnimationFrame).mockClear()
    await vi.advanceTimersByTimeAsync(1000)

    expect(engine.isPlaying).toBe(true)
    expect(engine.positionMs).toBeGreaterThanOrEqual(984)
    expect(songEngine.pause).toHaveBeenCalledTimes(previousPauses)
    expect(songEngine.destroy).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(onTime.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(onTime.mock.calls.length).toBeLessThanOrEqual(13)
    expect(vi.getTimerCount()).toBe(1)

    onTime.mockClear()
    engine.setVisualActive(true)
    expect(onTime).toHaveBeenCalledOnce()
    expect(onTime.mock.lastCall?.[0].globalMs).toBeCloseTo(1000)
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(songEngine.play).toHaveBeenCalledOnce()
    engine.destroy()
  })

  it('keeps count-in beats and song transitions advancing while hidden, then finishes without any RAF', async () => {
    const engine = new RehearsalAudioEngine()
    const configuration = playbackConfiguration()
    const song = configuration.songs[0]!
    song.durationMs = 400
    song.practice = { ...song.practice, countInBeats: 4, metronomeBpm: 240, playbackRate: 1 }
    const firstItem = fixtureRehearsal.items[0]!
    configuration.timeline = buildRehearsalTimeline([
      firstItem,
      { id: 'gap', kind: 'transition', durationMs: 1000 },
      { ...firstItem, id: 'second-song' }
    ], [song])
    const onEnded = vi.fn()
    const onTime = vi.fn()
    engine.onEnded(onEnded)
    engine.onTime(onTime)
    engine.setVisualActive(false)
    await engine.configure(configuration)
    await engine.play()
    await vi.advanceTimersByTimeAsync(configuration.timeline.totalDurationMs + 32)

    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(audioHarness.instances[0]!.load).toHaveBeenCalledTimes(2)
    expect(audioHarness.instances[0]!.play).toHaveBeenCalledTimes(2)
    expect(audioHarness.clicks).toHaveLength(8)
    const countIns = configuration.timeline.segments.filter((segment) => segment.kind === 'countIn')
    audioHarness.clicks.forEach((time, index) => {
      const due = countIns[Math.floor(index / 4)]!.startMs + (index % 4) * 250
      expect(time - due).toBeGreaterThanOrEqual(0)
      expect(time - due).toBeLessThanOrEqual(16)
    })
    expect(engine.isPlaying).toBe(false)
    expect(engine.positionMs).toBe(configuration.timeline.totalDurationMs)
    expect(onTime.mock.lastCall?.[1]).toBe(false)
    expect(onEnded).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    engine.destroy()
  })

  it('clears the background timer on pause and destroy', async () => {
    const engine = new RehearsalAudioEngine()
    const onTime = vi.fn()
    engine.onTime(onTime)
    engine.setVisualActive(false)
    await engine.configure(playbackConfiguration())
    await engine.play()
    await vi.advanceTimersByTimeAsync(100)
    engine.pause()
    const pausedAt = engine.positionMs
    onTime.mockClear()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(engine.positionMs).toBe(pausedAt)
    expect(onTime).not.toHaveBeenCalled()

    await engine.play()
    expect(vi.getTimerCount()).toBe(1)
    engine.destroy()
    expect(vi.getTimerCount()).toBe(0)
    expect(audioHarness.instances[0]!.destroy).toHaveBeenCalledOnce()
  })
})
