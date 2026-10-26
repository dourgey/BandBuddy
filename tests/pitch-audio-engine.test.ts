// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUITAR_SPLIT_STEMS, STEM_ORDER, createDefaultRecordingTrackState, type RecordingTake } from '../packages/shared/src/domain.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { MultiTrackAudioEngine } from '../src/renderer/src/audio-engine.js'
import { useRecordingPlayback } from '../src/renderer/src/recording-playback-state.js'

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
  setTargetAtTime(value: number): void { this.value = value }
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
class FakeBiquadNode extends FakeAudioNode {
  type = 'peaking'
  readonly frequency = new FakeAudioParam()
  readonly gain = new FakeAudioParam()
  readonly Q = new FakeAudioParam()
  getFrequencyResponse(_frequencies: Float32Array, magnitudes: Float32Array): void { magnitudes.fill(1) }
}
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
  readonly sampleRate = 48000
  readonly filters: FakeBiquadNode[] = []
  createBiquadFilter(): FakeBiquadNode { const filter = new FakeBiquadNode(); this.filters.push(filter); return filter }
  static latest: FakeAudioContext | null = null
  readonly audioWorklet = {}
  readonly destination = new FakeDestinationNode()
  readonly gains: FakeGainNode[] = []
  readonly delays: FakeDelayNode[] = []
  readonly sources: FakeMediaSourceNode[] = []
  readonly mergers: FakeChannelMergerNode[] = []
  readonly splitters: FakeChannelSplitterNode[] = []
  currentTime = 1
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

class FakeAudioElement extends EventTarget { readyState = 4;
  seeking = false
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
  it('reports a failed recording play and retries that source while backing keeps running', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    song.recordingTracks = [{ ...createDefaultRecordingTrackState(song.id, 'retry-record'), activeTakeId: 'take' }]
    song.recordingTakes = [{ id: 'take', recordingTrackId: 'retry-record', playbackRate: 1, pitchSemitones: 0, previewMediaUrl: 'https://audio.test/retry.flac' } as RecordingTake]
    const engine = new MultiTrackAudioEngine()
    try {
      await engine.load(song)
      const failed = FakeAudioContext.latest!.sources.at(-1)!.element
      vi.spyOn(failed, 'play').mockRejectedValueOnce(new Error('decode failed'))
      expect(await engine.play()).toBe(true)
      expect(useRecordingPlayback.getState().tracks['retry-record']?.phase).toBe('failed')
      expect(FakeAudioContext.latest!.sources[0]!.element.paused).toBe(false)
      await engine.updateRecordingSources(song)
      expect(FakeAudioContext.latest!.sources.at(-1)!.element).not.toBe(failed)
      expect(FakeAudioContext.latest!.sources.at(-1)!.element.paused).toBe(false)
      expect(useRecordingPlayback.getState().tracks['retry-record']?.phase).toBe('ready')
    } finally { engine.destroy() }
    expect(useRecordingPlayback.getState().tracks['retry-record']).toBeUndefined()
  })
  it('cancels superseded tone loads so late completion cannot replace the latest selected source', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const engine = new MultiTrackAudioEngine()
    try {
      await engine.load(song)
      const pending: FakeAudioElement[] = []
      vi.stubGlobal('Audio', class extends FakeAudioElement { constructor() { super(); this.readyState = 0; pending.push(this) } })
      const track = { ...createDefaultRecordingTrackState(song.id, 'cancel-record'), activeTakeId: 'take' }
      const take = { id: 'take', recordingTrackId: track.id, playbackRate: 1, pitchSemitones: 0, previewMediaUrl: 'https://audio.test/first.flac' } as RecordingTake
      const first = engine.updateRecordingSources({ ...song, recordingTracks: [track], recordingTakes: [take] })
      const second = engine.updateRecordingSources({ ...song, recordingTracks: [track], recordingTakes: [{ ...take, previewMediaUrl: 'https://audio.test/latest.flac' }] })
      pending[0]!.dispatchEvent(new Event('canplay'))
      await first
      expect(useRecordingPlayback.getState().tracks[track.id]?.phase).toBe('loading')
      pending[1]!.readyState = 4; pending[1]!.dispatchEvent(new Event('canplay'))
      await second
      expect(FakeAudioContext.latest!.sources.at(-1)!.element.src).toContain('/latest.flac')
      expect(useRecordingPlayback.getState().tracks[track.id]?.phase).toBe('ready')
    } finally { engine.destroy() }
  })
  it('applies recording M/S and gain immediately during a tone load, and does not reload for mixer edits', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    const track = { ...createDefaultRecordingTrackState(song.id, 'saved-recording'), activeTakeId: 'take', solo: true }
    song.recordingTracks = [track]
    song.recordingTakes = [{ id: 'take', recordingTrackId: track.id, playbackRate: .5, pitchSemitones: -3, previewMediaUrl: 'https://audio.test/take.flac' } as RecordingTake]
    const engine = new MultiTrackAudioEngine()
    let pending: FakeAudioElement | undefined
    try {
      await engine.load(song); await engine.play()
      const original = FakeAudioContext.latest!.sources.at(-1)!
      const originalGain = original.connections[0]!.destination as FakeGainNode
      expect(original.element.playbackRate).toBe(2)
      expect(originalGain.gain.value).toBe(1)
      expect(new URL(original.element.src).searchParams.get('pitch')).toBe('3')
      vi.stubGlobal('Audio', class extends FakeAudioElement { constructor() { super(); this.readyState = 0; pending = this } })
      const tone = { ...song, recordingTakes: [{ ...song.recordingTakes[0]!, previewMediaUrl: 'https://audio.test/new-tone.flac' }] }
      const refresh = engine.updateRecordingSources(tone)
      const muted = { ...tone, recordingTracks: [{ ...track, muted: true }] }
      const mixRefresh = engine.updateRecordingSources(muted)
      expect(originalGain.gain.value).toBe(0)
      const samePending = pending
      const audible = { ...tone, recordingTracks: [{ ...track, gainDb: -12 }] }
      const finalRefresh = engine.updateRecordingSources(audible)
      expect(originalGain.gain.value).toBeCloseTo(.251188)
      expect(pending).toBe(samePending)
      expect(original.element.paused).toBe(false)
      pending!.readyState = 4; pending!.dispatchEvent(new Event('canplay'))
      await Promise.all([refresh, mixRefresh, finalRefresh])
      const replacement = FakeAudioContext.latest!.sources.at(-1)!
      expect((replacement.connections[0]!.destination as FakeGainNode).gain.value).toBeCloseTo(.251188)
      expect(replacement.element.paused).toBe(false)
    } finally { engine.destroy() }
  })
  it('plays backing immediately while a saved wet take is loading, then joins the take at the current position', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    const engine = new MultiTrackAudioEngine()
    let pending: FakeAudioElement | undefined, refresh: Promise<void> | undefined, play: Promise<boolean> | undefined
    try {
      await engine.load(song)
      const stems = [...FakeAudioContext.latest!.sources]
      vi.stubGlobal('Audio', class extends FakeAudioElement { constructor() { super(); this.readyState = 0; pending = this } })
      const track = { ...createDefaultRecordingTrackState(song.id, 'saved-recording'), activeTakeId: 'saved-take' }
      refresh = engine.updateRecordingSources({ ...song, recordingTracks: [track], recordingTakes: [{ id: 'saved-take', recordingTrackId: track.id, playbackRate: 1, pitchSemitones: 0, previewMediaUrl: 'https://audio.test/wet-preview.flac' } as RecordingTake] })
      await vi.waitFor(() => expect(pending).toBeDefined())
      let started = false
      play = engine.play().then(value => { started = value; return value })
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 300 })
      for (const { element } of stems) { expect(element.paused).toBe(false); element.currentTime = 17 }
      pending!.readyState = 4; pending!.dispatchEvent(new Event('canplay')); await refresh
      expect(pending).toMatchObject({ paused: false, currentTime: 17 })
      engine.pause(); expect(pending!.paused).toBe(true)
    } finally {
      pending?.dispatchEvent(new Event('canplay')); await refresh; await play; engine.destroy()
    }
  })
  it('keeps media transport, mixer gains and pitch processing untouched during continuous EQ edits', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.countInBeats = 0; song.practice.metronomeEnabled = false
    song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    const engine = new MultiTrackAudioEngine({ applySongEq: true })
    try {
      await engine.load(song); engine.seek(25000); await engine.play()
      const context = FakeAudioContext.latest!
      const writes = context.sources.map(({ element, connections }) => {
        let rate = element.playbackRate
        const setRate = vi.fn((value: number) => { rate = value })
        Object.defineProperty(element, 'playbackRate', { get: () => rate, set: setRate })
        return { setRate, pause: vi.spyOn(element, 'pause'), play: vi.spyOn(element, 'play'),
          gain: vi.spyOn((connections[0]!.destination as FakeGainNode).gain, 'linearRampToValueAtTime') }
      })
      stretchMock.node.schedule.mockClear()
      for (let i = 0; i < 120; i++) {
        context.currentTime += 1 / 60
        engine.applyPractice({ ...song.practice,
          eq: { ...song.practice.eq, enabled: true, mode: 'parametric', nodes: [{ id: 'drag', frequency: 80 + i * 100, gainDb: 6, q: 2 }] }
        })
      }
      for (const spy of writes) for (const value of Object.values(spy)) expect(value).not.toHaveBeenCalled()
      expect(stretchMock.node.schedule).not.toHaveBeenCalled()
      for (const { element } of context.sources) expect(element).toMatchObject({ paused: false, currentTime: 25 })
      context.currentTime += .1
      const bus = (engine as unknown as { musicEq: { firstBank: FakeBiquadNode[]; secondBank: FakeBiquadNode[]; activeBank: number } }).musicEq
      await vi.waitFor(() => expect((bus.activeBank === 0 ? bus.firstBank : bus.secondBank)[0]).toMatchObject({ frequency: { value: 11980 }, gain: { value: 6 } }))
    } finally { engine.destroy() }
  })
  it('inserts identical discrete EQ on all output channels and keeps metronome outside the recording EQ', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.recordingTracks = [{ ...createDefaultRecordingTrackState(song.id, 'recording-track'), activeTakeId: 'take' }]
    song.recordingTakes = [{ id: 'take', recordingTrackId: 'recording-track', playbackRate: 1, pitchSemitones: 0, previewMediaUrl: 'https://audio.test/recording.wav' } as RecordingTake]
    song.practice.eq.enabled = true; song.practice.eq.graphicGains[5] = 7
    const engine = new MultiTrackAudioEngine({ applySongEq: true })
    await engine.load(song)
    const context = FakeAudioContext.latest!
    const internals = engine as unknown as { musicEq: { input: FakeGainNode; output: FakeGainNode }; recordingEq: { input: FakeGainNode; output: FakeGainNode }; recordingBus: FakeGainNode; recordingDelay: FakeAudioNode; master: FakeGainNode; auxiliaryBus: FakeGainNode; metronomeMerger: FakeAudioNode; outputMerger: FakeAudioNode }
    expect(internals.outputMerger.connections[0]!.destination).toBe(internals.musicEq.input)
    expect(internals.musicEq.input).toMatchObject({ channelCount: 12, channelInterpretation: 'discrete' })
    expect(internals.recordingEq.input).toMatchObject({ channelCount: 2, channelInterpretation: 'discrete' })
    expect(internals.recordingEq.output.connections[0]!.destination).toBe(internals.recordingBus)
    expect(internals.recordingBus.connections[0]!.destination).toBe(internals.recordingDelay)
    expect(internals.recordingDelay.connections[0]!.destination).toBe(internals.master)
    const recordingGain = context.sources.at(-1)!.connections[0]!.destination as FakeGainNode
    expect(recordingGain.connections[0]!.destination).toBe(internals.recordingEq.input)
    const buses = internals as unknown as { musicEq: { firstBank: FakeBiquadNode[]; secondBank: FakeBiquadNode[]; activeBank: number }; recordingEq: { firstBank: FakeBiquadNode[]; secondBank: FakeBiquadNode[]; activeBank: number } }
    const runtimeFilters = [buses.musicEq, buses.recordingEq].flatMap(bus => [...bus.firstBank, ...bus.secondBank])
    expect(runtimeFilters).toHaveLength(40)
    const activeFilters = [buses.musicEq, buses.recordingEq].flatMap(bus => bus.activeBank === 0 ? bus.firstBank : bus.secondBank)
    expect(activeFilters.filter(filter => filter.frequency.value === 1000 && filter.gain.value === 7)).toHaveLength(2)
    expect(internals.metronomeMerger.connections.some(route => route.destination === internals.musicEq.input || route.destination === internals.recordingEq.input)).toBe(false)
    engine.destroy()
  })
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

  it.each([false, true])('fades a sustained offset once and restores the latest mute state (recording=%s)', async recording => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.countInBeats = 0; song.practice.metronomeEnabled = false
    song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    song.recordingTracks = [{ ...createDefaultRecordingTrackState(song.id, 'record'), activeTakeId: 'take' }]
    song.recordingTakes = [{ id: 'take', recordingTrackId: 'record', playbackRate: .5, pitchSemitones: 0, previewMediaUrl: 'https://audio.test/take.wav' } as RecordingTake]
    const engine = new MultiTrackAudioEngine()
    try {
      await engine.load(song); engine.seek(10_000); await engine.play()
      const context = FakeAudioContext.latest!
      const source = recording ? context.sources.at(-1)! : context.sources[STEM_ORDER.indexOf('bass')]!
      const element = source.element, gain = (source.connections[0]!.destination as FakeGainNode).gain
      const internal = engine as unknown as { monitor(): void; resyncs: Map<unknown, unknown> }
      let position = element.currentTime - (recording ? .5 : .25)
      const seek = vi.fn((value: number) => { position = value; element.seeking = true })
      Object.defineProperty(element, 'currentTime', { get: () => position, set: seek })
      for (let frame = 0; frame < 20; frame++) { context.currentTime += .1; internal.monitor() }
      expect(internal.resyncs.size).toBe(1)
      expect(gain.value).toBe(0)
      expect(seek).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(15)
      expect(seek).toHaveBeenCalledExactlyOnceWith(recording ? 20 : 10)
      for (let frame = 0; frame < 20; frame++) { context.currentTime += .1; internal.monitor() }
      expect(seek).toHaveBeenCalledTimes(1)
      if (recording) engine.updateRecordingMix({ ...song, recordingTracks: song.recordingTracks.map(track => ({ ...track, muted: true })) })
      else engine.applyPractice({ ...song.practice, tracks: song.practice.tracks.map(track => ({ ...track, muted: track.stemType === 'bass' })) })
      expect(gain.value).toBe(0)
      element.seeking = false; element.dispatchEvent(new Event('canplay'))
      expect(internal.resyncs.size).toBe(0)
      expect(gain.value).toBe(0)
    } finally { engine.destroy(); vi.useRealTimers() }
  })

  it.each(['pause', 'seek', 'destroy'] as const)('cancels a pending recovery when the user requests %s', async action => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.countInBeats = 0; song.practice.metronomeEnabled = false
    song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
    const engine = new MultiTrackAudioEngine()
    try {
      await engine.load(song); engine.seek(10_000); await engine.play()
      const context = FakeAudioContext.latest!, element = context.sources[STEM_ORDER.indexOf('bass')]!.element
      const internal = engine as unknown as { monitor(): void; resyncs: Map<unknown, unknown> }
      let position = 9.75
      const seek = vi.fn((value: number) => { position = value })
      Object.defineProperty(element, 'currentTime', { get: () => position, set: seek })
      for (let frame = 0; frame < 20; frame++) { context.currentTime += .1; internal.monitor() }
      expect(internal.resyncs.size).toBe(1)
      if (action === 'seek') engine.seek(20_000)
      else engine[action]()
      seek.mockClear()
      await vi.advanceTimersByTimeAsync(100)
      expect(seek).not.toHaveBeenCalled()
      expect(internal.resyncs.size).toBe(0)
      if (action === 'seek') expect(position).toBe(20)
    } finally { engine.destroy(); vi.useRealTimers() }
  })

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
    const vocalsGain = context.sources[STEM_ORDER.indexOf('vocals')]!.connections[0]!.destination as FakeGainNode
    const drumsGain = context.sources[STEM_ORDER.indexOf('drums')]!.connections[0]!.destination as FakeGainNode
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
      outputChannelCount: [20],
      channelCount: 20,
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
      vocals: [0, 1], lead_vocals: [2, 3], backing_vocals: [4, 5], bass: [6, 7], guitar: [8, 9], acoustic_guitar: [10, 11],
      lead_guitar: [12, 13], rhythm_guitar: [14, 15], piano: [16, 17], other: [18, 19]
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
      output: 18,
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
    const gainsByStem = Object.fromEntries(STEM_ORDER.map((stemType, index) => [stemType, context.sources[index]!.connections[0]!.destination as FakeGainNode]))
    const internals = engine as unknown as { outputConnections: unknown[] }
    expect(internals.outputConnections).toHaveLength(14)

    vi.useFakeTimers()
    try {
      const splitPractice = { ...song.practice, guitarSplitEnabled: true }
      engine.applyPractice(splitPractice)
      expect(internals.outputConnections).toHaveLength(24)
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
        const element = context.sources.findLast(source => source.element.src === `https://audio.test/${stem}.flac`)!.element
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
it('attaches a newly saved take and replaces its tone while stems keep playing at their current positions', async () => {
  const song = fixtureDetail(fixtureSongs[0]!)
  song.stems = song.stems.map(stem => ({ ...stem, mediaUrl: `https://audio.test/${stem.type}.wav` }))
  const engine = new MultiTrackAudioEngine()
  try {
    await engine.load(song); await engine.play()
    const context = FakeAudioContext.latest!, stems = [...context.sources]
    stems.forEach(({ element }) => { element.currentTime = 24 })
    const track = { ...createDefaultRecordingTrackState(song.id, 'recording-track'), activeTakeId: 'take' }
    const take = { id: 'take', recordingTrackId: track.id, playbackRate: 1, pitchSemitones: 0, previewMediaUrl: 'https://audio.test/recording.wav' } as RecordingTake
    const recorded = { ...song, recordingTracks: [track], recordingTakes: [take] }
    await engine.updateRecordingSources(recorded)
    expect(context.sources.at(-1)!.element).toMatchObject({ paused: false, currentTime: 24 })
    const tone = { enabled: true, presetId: null, monitorMode: 'off' as const, chain: (await import('../packages/shared/src/arsenal.js')).defaultEffectChain() }
    await engine.updateRecordingSources({ ...recorded, recordingTracks: [{ ...track, effects: tone }] })
    expect(context.sources.at(-1)!.element).toMatchObject({ paused: false, currentTime: 24 })
    expect(context.sources.at(-1)!.element.src).toContain('tone=')
    for (const { element } of stems) expect(element).toMatchObject({ paused: false, currentTime: 24 })
    engine.pause(); expect(context.sources.at(-1)!.element.paused).toBe(true)
    await engine.play(); expect(context.sources.at(-1)!.element.paused).toBe(false)
  } finally { engine.destroy() }
})

})
