// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUITAR_SPLIT_STEMS, STEM_ORDER } from '../packages/shared/src/domain.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { MultiTrackAudioEngine } from '../src/renderer/src/audio-engine.js'

const stretchMock = vi.hoisted(() => {
  const node = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(async (change: unknown) => change),
    schedule: vi.fn(async (change: unknown) => change),
    stop: vi.fn(async () => undefined),
    latency: vi.fn(async () => 0.125)
  }
  node.connect.mockReturnValue(node)
  return { node, create: vi.fn(async () => node) }
})

vi.mock('signalsmith-stretch', () => ({ default: stretchMock.create }))

class FakeAudioParam {
  value = 0
  cancelScheduledValues(): void {}
  setValueAtTime(value: number): void { this.value = value }
  linearRampToValueAtTime(value: number): void { this.value = value }
  exponentialRampToValueAtTime(value: number): void { this.value = value }
}

class FakeAudioNode {
  channelCount = 2
  channelCountMode: ChannelCountMode = 'max'
  channelInterpretation: ChannelInterpretation = 'speakers'
  readonly connections: Array<{ destination: unknown; output: number; input: number }> = []
  connect(destination: unknown, output = 0, input = 0): unknown {
    this.connections.push({ destination, output, input })
    return destination
  }
  disconnect(): void {}
}

class FakeDestinationNode extends FakeAudioNode { readonly maxChannelCount = 12 }
class FakeChannelMergerNode extends FakeAudioNode {
  constructor(readonly numberOfInputs: number) { super() }
}
class FakeChannelSplitterNode extends FakeAudioNode {
  constructor(readonly numberOfOutputs: number) { super() }
}

class FakeGainNode extends FakeAudioNode { readonly gain = new FakeAudioParam() }
class FakeDelayNode extends FakeAudioNode { readonly delayTime = new FakeAudioParam() }
class FakeCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam()
  readonly knee = new FakeAudioParam()
  readonly ratio = new FakeAudioParam()
  readonly attack = new FakeAudioParam()
  readonly release = new FakeAudioParam()
}

class FakeMediaSourceNode extends FakeAudioNode {
  constructor(readonly element: FakeAudioElement) { super() }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null
  readonly audioWorklet = {}
  readonly destination = new FakeDestinationNode()
  readonly gains: FakeGainNode[] = []
  readonly delays: FakeDelayNode[] = []
  readonly sources: FakeMediaSourceNode[] = []
  readonly mergers: FakeChannelMergerNode[] = []
  readonly splitters: FakeChannelSplitterNode[] = []
  readonly currentTime = 1
  readonly state = 'running'

  constructor() { FakeAudioContext.latest = this }
  createGain(): FakeGainNode { const node = new FakeGainNode(); this.gains.push(node); return node }
  createDelay(): FakeDelayNode { const node = new FakeDelayNode(); this.delays.push(node); return node }
  createDynamicsCompressor(): FakeCompressorNode { return new FakeCompressorNode() }
  createMediaElementSource(element: FakeAudioElement): FakeMediaSourceNode {
    const node = new FakeMediaSourceNode(element); this.sources.push(node); return node
  }
  createChannelMerger(channelCount: number): FakeChannelMergerNode {
    const node = new FakeChannelMergerNode(channelCount); this.mergers.push(node); return node
  }
  createChannelSplitter(channelCount: number): FakeChannelSplitterNode {
    const node = new FakeChannelSplitterNode(channelCount); this.splitters.push(node); return node
  }
  close(): Promise<void> { return Promise.resolve() }
  resume(): Promise<void> { return Promise.resolve() }
}

class FakeAudioElement {
  preload = ''
  crossOrigin: string | null = null
  preservesPitch = true
  src = ''
  playbackRate = 1
  currentTime = 0
  paused = true
  ended = false
  play(): Promise<void> { this.paused = false; return Promise.resolve() }
  pause(): void { this.paused = true }
  removeAttribute(name: string): void { if (name === 'src') this.src = '' }
  load(): void {}
}

describe('Signalsmith realtime pitch graph', () => {
  beforeEach(() => {
    stretchMock.create.mockClear()
    stretchMock.node.connect.mockClear()
    stretchMock.node.disconnect.mockClear()
    stretchMock.node.start.mockClear()
    stretchMock.node.schedule.mockClear()
    stretchMock.node.latency.mockClear()
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', class {})
    vi.stubGlobal('Audio', FakeAudioElement)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('routes harmonic stems through Signalsmith while drums use the latency-aligned bypass', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice = {
      ...song.practice,
      pitchSemitones: 5,
      tracks: song.practice.tracks.map((track) => ({
        ...track,
        outputChannelPair: track.stemType === 'vocals' ? 5 : track.stemType === 'drums' ? 3 : 1
      }))
    }
    const engine = new MultiTrackAudioEngine()

    await engine.load(song)

    const context = FakeAudioContext.latest!
    const harmonicBus = context.mergers[0]!
    const vocalsGain = context.gains[5]!
    const drumsGain = context.gains[6]!
    const harmonicOutputSplitter = context.splitters[0]!
    const drumsOutputSplitter = context.splitters[1]!
    const vocalsInputSplitter = context.splitters[3]!
    const outputMerger = context.mergers.at(-1)!
    const bypassDelay = context.delays[1]!
    const auxiliaryDelay = context.delays[2]!
    for (const source of context.sources) {
      expect(source.connections[0]!.destination).toMatchObject({
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
      })
    }
    expect(context.gains[4]).toMatchObject({ channelCount: 2, channelCountMode: 'explicit' })
    expect(stretchMock.create).toHaveBeenCalledTimes(1)
    expect((stretchMock.create as typeof stretchMock.create & { moduleUrl?: string }).moduleUrl)
      .toMatch(/SignalsmithStretch\.mjs$/)
    expect((stretchMock.create as typeof stretchMock.create & { moduleUrl?: string }).moduleUrl)
      .not.toMatch(/^blob:/)
    expect(stretchMock.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outputChannelCount: [16],
      channelCount: 16,
      channelInterpretation: 'discrete'
    }))
    expect(harmonicBus.connections.some(({ destination }) => destination === stretchMock.node)).toBe(true)
    expect(vocalsGain.connections.some(({ destination }) => destination === vocalsInputSplitter)).toBe(true)
    expect(vocalsInputSplitter.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination: harmonicBus, output: 0, input: 0 }),
      expect.objectContaining({ destination: harmonicBus, output: 1, input: 1 })
    ]))
    expect(drumsGain.connections.some(({ destination }) => destination === bypassDelay)).toBe(true)
    for (const [stemType, channels] of Object.entries({
      vocals: [0, 1], bass: [2, 3], guitar: [4, 5], acoustic_guitar: [6, 7],
      lead_guitar: [8, 9], rhythm_guitar: [10, 11], piano: [12, 13], other: [14, 15]
    })) {
      const source = context.sources[STEM_ORDER.indexOf(stemType as (typeof STEM_ORDER)[number])]!
      const gain = source.connections[0]!.destination as FakeGainNode
      const splitter = gain.connections[0]!.destination as FakeChannelSplitterNode
      expect(splitter.connections).toEqual(channels.map((input, output) => ({ destination: harmonicBus, output, input })))
      expect(gain.connections.some(({ destination }) => destination === bypassDelay)).toBe(false)
    }
    expect(drumsGain.connections).toEqual([{ destination: bypassDelay, output: 0, input: 0 }])
    expect(harmonicOutputSplitter.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination: outputMerger, output: 0, input: 4 }),
      expect.objectContaining({ destination: outputMerger, output: 1, input: 5 })
    ]))
    expect(drumsOutputSplitter.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination: outputMerger, output: 0, input: 2 }),
      expect.objectContaining({ destination: outputMerger, output: 1, input: 3 })
    ]))
    expect(outputMerger.numberOfInputs).toBe(12)
    expect(engine.availableOutputChannelPairs).toBe(6)
    expect(stretchMock.node.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ semitones: 5 }))
    expect(bypassDelay.delayTime.value).toBe(0.125)
    expect(auxiliaryDelay.delayTime.value).toBe(0.125)
    expect(engine.outputLatencySeconds).toBe(0.125)

    const routeCountBeforeGain = harmonicOutputSplitter.connections.length
    engine.applyPractice({ ...song.practice, masterGainDb: -3 })
    expect(stretchMock.node.schedule).toHaveBeenCalledTimes(1)
    expect(harmonicOutputSplitter.connections).toHaveLength(routeCountBeforeGain)
    const unchangedRouteCount = harmonicOutputSplitter.connections.length

    engine.applyPractice({
      ...song.practice,
      tracks: song.practice.tracks.map((track) => (
        track.stemType === 'vocals' ? { ...track, outputChannelPair: 7 } : track
      ))
    })
    expect(harmonicOutputSplitter.connections.length).toBeGreaterThan(unchangedRouteCount)
    expect(harmonicOutputSplitter.connections.at(-2)).toMatchObject({
      destination: outputMerger,
      output: 14,
      input: 0
    })
    expect(harmonicOutputSplitter.connections).toContainEqual(
      expect.objectContaining({ destination: outputMerger, output: 0, input: 6 })
    )

    engine.applyPractice({ ...song.practice, pitchSemitones: 0 })
    await (engine as unknown as { pitchTransition: Promise<void> }).pitchTransition
    expect(stretchMock.node.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }))
    expect(bypassDelay.delayTime.value).toBe(0)
    expect(auxiliaryDelay.delayTime.value).toBe(0)
    expect(engine.outputLatencySeconds).toBe(0)
    engine.destroy()
  })

  it('crossfades guitar modes and removes the hidden alternative from hardware routing', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.stems = song.stems.map((stem) => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.flac` }))
    const engine = new MultiTrackAudioEngine()
    await engine.load(song)
    const context = FakeAudioContext.latest!
    const gainsByStem = Object.fromEntries(STEM_ORDER.map((stemType, index) => [stemType, context.gains[index + 5]!]))
    const internals = engine as unknown as { outputConnections: unknown[] }
    expect(internals.outputConnections).toHaveLength(14)

    vi.useFakeTimers()
    try {
      const splitPractice = { ...song.practice, guitarSplitEnabled: true }
      engine.applyPractice(splitPractice)
      expect(internals.outputConnections).toHaveLength(20)
      expect(gainsByStem.guitar!.gain.value).toBe(0)
      expect(gainsByStem.acoustic_guitar!.gain.value).toBe(1)
      expect(gainsByStem.lead_guitar!.gain.value).toBe(1)
      expect(gainsByStem.rhythm_guitar!.gain.value).toBe(1)

      await vi.advanceTimersByTimeAsync(40)
      expect(internals.outputConnections).toHaveLength(18)
    } finally {
      vi.useRealTimers()
      engine.destroy()
    }
  })

  it('attaches completed guitar stems at the current position without reloading the practice room', async () => {
    const baseSong = fixtureDetail(fixtureSongs[0]!)
    baseSong.practice = { ...baseSong.practice, guitarSplitEnabled: false, positionMs: 12_000 }
    baseSong.stems = baseSong.stems
      .filter((stem) => !GUITAR_SPLIT_STEMS.includes(stem.type as (typeof GUITAR_SPLIT_STEMS)[number]))
      .map((stem) => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.flac` }))
    const completedSong = fixtureDetail(fixtureSongs[0]!)
    completedSong.practice = baseSong.practice
    completedSong.stems = completedSong.stems.map((stem) => ({
      ...stem,
      mediaUrl: `https://audio.test/${stem.type}.flac`
    }))
    const engine = new MultiTrackAudioEngine()

    try {
      await engine.load(baseSong)
      await engine.play()
      const context = FakeAudioContext.latest!
      context.sources[STEM_ORDER.indexOf('vocals')]!.element.currentTime = 31

      await engine.updateStemSources(completedSong)

      for (const stem of GUITAR_SPLIT_STEMS) {
        const element = context.sources[STEM_ORDER.indexOf(stem)]!.element
        expect(element).toMatchObject({
          src: `https://audio.test/${stem}.flac`,
          currentTime: 31,
          paused: false
        })
      }
    } finally {
      engine.destroy()
    }
  })

  it.each([-12, 12])('changes pitch to %s during playback without changing tempo or moving any stem', async (pitchSemitones) => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.playbackRate = 0.8
    song.practice.positionMs = 25_000
    song.stems = song.stems.map((stem) => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    const engine = new MultiTrackAudioEngine()
    try {
      await engine.load(song)
      await engine.play()
      engine.applyPractice({ ...song.practice, pitchSemitones })
      await (engine as unknown as { pitchTransition: Promise<void> }).pitchTransition

      expect(stretchMock.node.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, semitones: pitchSemitones }))
      for (const { element } of FakeAudioContext.latest!.sources) {
        expect(element).toMatchObject({ playbackRate: 0.8, preservesPitch: true, currentTime: 25, paused: false })
      }
      engine.seek(43_000)
      engine.applyPractice({ ...song.practice, pitchSemitones, playbackRate: 1.2 })
      expect(stretchMock.node.schedule).toHaveBeenCalledTimes(1)
      for (const { element } of FakeAudioContext.latest!.sources) {
        expect(element).toMatchObject({ playbackRate: 1.2, preservesPitch: true, currentTime: 43, paused: false })
      }
    } finally {
      engine.destroy()
    }
  })

  it('applies only the latest pitch when the user steps rapidly during processor initialization', async () => {
    let releaseNode: ((node: typeof stretchMock.node) => void) | undefined
    stretchMock.create.mockImplementationOnce(() => new Promise((resolve) => { releaseNode = resolve }))
    const song = fixtureDetail(fixtureSongs[0]!)
    const engine = new MultiTrackAudioEngine()
    try {
      await engine.load(song)
      engine.applyPractice({ ...song.practice, pitchSemitones: 1 })
      engine.applyPractice({ ...song.practice, pitchSemitones: -3 })
      engine.applyPractice({ ...song.practice, pitchSemitones: 12 })
      await vi.waitFor(() => expect(releaseNode).toBeTypeOf('function'))
      releaseNode!(stretchMock.node)
      await (engine as unknown as { pitchTransition: Promise<void> }).pitchTransition

      expect(stretchMock.create).toHaveBeenCalledTimes(1)
      expect(stretchMock.node.schedule).toHaveBeenCalledTimes(1)
      expect(stretchMock.node.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ semitones: 12 }))
      engine.applyPractice({ ...song.practice, pitchSemitones: 0 })
      await (engine as unknown as { pitchTransition: Promise<void> }).pitchTransition
      expect(engine.outputLatencySeconds).toBe(0)
      expect(FakeAudioContext.latest!.delays.every((delay) => delay.delayTime.value === 0)).toBe(true)
    } finally {
      engine.destroy()
    }
  })

  it('restores the original audio and drum timing if pitch initialization fails, then allows a retry', async () => {
    stretchMock.node.latency.mockRejectedValueOnce(new Error('pitch processor unavailable'))
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.pitchSemitones = 5
    const engine = new MultiTrackAudioEngine()
    const onError = vi.fn()
    engine.onError(onError)
    try {
      await engine.load(song)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(engine.outputLatencySeconds).toBe(0)
      expect(FakeAudioContext.latest!.delays.every((delay) => delay.delayTime.value === 0)).toBe(true)

      engine.applyPractice({ ...song.practice, pitchSemitones: 0 })
      await (engine as unknown as { pitchTransition: Promise<void> }).pitchTransition
      engine.applyPractice(song.practice)
      await (engine as unknown as { pitchTransition: Promise<void> }).pitchTransition
      expect(stretchMock.create).toHaveBeenCalledTimes(2)
      expect(stretchMock.node.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, semitones: 5 }))
      expect(engine.outputLatencySeconds).toBe(0.125)
    } finally {
      engine.destroy()
    }
  })
})
