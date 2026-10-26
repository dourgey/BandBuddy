import { EQ_FREQUENCIES, EQ_GRAPHIC_Q, EQ_MAX_NODES, normalizeSongEq, type SongEqState } from '@shared/equalizer.js'

export const EQ_RESPONSE_POINTS = 512
export const EQ_FFT_SIZE = 4096
export interface EqVisualData {
  frequencies: Float32Array<ArrayBuffer>
  responseDb: Float32Array<ArrayBuffer>
  spectrumDb: Float32Array<ArrayBuffer>
  sampleRate: number
  compensationDb: number
}

interface Band { frequency: number; gainDb: number; q: number }
interface EqConfiguration {
  state: SongEqState
  graphic: Band[]
  parametric: Band[]
  graphicCompensation: number
  parametricCompensation: number
}

function bandsFor(state: SongEqState, sampleRate: number): { graphic: Band[]; parametric: Band[] } {
  const frequency = (hz: number): number => Math.min(hz, sampleRate * 0.49)
  return {
    graphic: EQ_FREQUENCIES.map((hz, index) => ({ frequency: frequency(hz), gainDb: state.graphicGains[index]!, q: EQ_GRAPHIC_Q })),
    parametric: Array.from({ length: EQ_MAX_NODES }, (_, index) => {
      const node = state.nodes[index]
      return { frequency: frequency(node?.frequency ?? 1000), gainDb: node?.gainDb ?? 0, q: node?.q ?? 1 }
    })
  }
}

/** The same native filter response supplies both the plot and headroom compensation. */
export class EqResponse {
  readonly frequencies = Float32Array.from({ length: EQ_RESPONSE_POINTS }, (_, index) => 20 * 1000 ** (index / (EQ_RESPONSE_POINTS - 1)))
  readonly responseDb = new Float32Array(EQ_RESPONSE_POINTS)
  private readonly filters: BiquadFilterNode[]
  private readonly magnitude = new Float32Array(EQ_RESPONSE_POINTS)
  private readonly phase = new Float32Array(EQ_RESPONSE_POINTS)
  private readonly sums = new Float32Array(EQ_RESPONSE_POINTS)
  compensationDb = 0

  constructor(private readonly context: BaseAudioContext) {
    this.filters = Array.from({ length: 10 }, () => { const node = context.createBiquadFilter(); node.type = 'peaking'; return node })
    for (let index = 0; index < this.frequencies.length; index++) this.frequencies[index] = Math.min(this.frequencies[index]!, context.sampleRate * 0.49)
  }

  configure(value: SongEqState): EqConfiguration {
    const state = normalizeSongEq(value)
    const bands = bandsFor(state, this.context.sampleRate)
    const graphicCompensation = this.calculate(bands.graphic)
    if (state.mode === 'graphic') this.responseDb.set(this.sums)
    const parametricCompensation = this.calculate(bands.parametric)
    if (state.mode === 'parametric') this.responseDb.set(this.sums)
    this.compensationDb = state.enabled ? (state.mode === 'graphic' ? graphicCompensation : parametricCompensation) : 0
    if (!state.enabled) this.responseDb.fill(0)
    return { state, ...bands, graphicCompensation, parametricCompensation }
  }

  private calculate(bands: Band[]): number {
    this.sums.fill(0)
    for (let index = 0; index < bands.length; index++) {
      const filter = this.filters[index]!, band = bands[index]!
      filter.frequency.value = band.frequency; filter.gain.value = band.gainDb; filter.Q.value = band.q
      filter.getFrequencyResponse(this.frequencies, this.magnitude, this.phase)
      for (let point = 0; point < this.sums.length; point++) this.sums[point]! += 20 * Math.log10(Math.max(1e-12, this.magnitude[point]!))
    }
    let peak = 0
    for (const db of this.sums) peak = Math.max(peak, db)
    // Include narrow node centres that may fall between the log-spaced samples.
    const centres = Float32Array.from(bands.map(band => band.frequency)), mag = new Float32Array(centres.length), phase = new Float32Array(centres.length)
    const sums = new Float32Array(centres.length)
    for (let index = 0; index < bands.length; index++) {
      this.filters[index]!.getFrequencyResponse(centres, mag, phase)
      for (let point = 0; point < sums.length; point++) sums[point]! += 20 * Math.log10(Math.max(1e-12, mag[point]!))
    }
    for (const db of sums) peak = Math.max(peak, db)
    return -peak
  }

  destroy(): void { for (const filter of this.filters) filter.disconnect() }
}

/** Discrete channels are filtered independently; no speaker-layout downmix enters the output. */
export class SongEqBus {
  readonly input: GainNode
  readonly output: GainNode
  private readonly dry: GainNode
  private readonly firstBank: BiquadFilterNode[]
  private readonly secondBank: BiquadFilterNode[]
  private readonly firstGain: GainNode
  private readonly secondGain: GainNode
  private readonly firstHeadroom: GainNode
  private readonly secondHeadroom: GainNode
  private splitter: ChannelSplitterNode | null = null
  private analysers: Array<{ node: AnalyserNode; data: Float32Array<ArrayBuffer> }> = []
  private activeBank = -1
  private transitionEnd = 0
  private pending: EqConfiguration | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly context: BaseAudioContext, private readonly channels: number) {
    const configure = <T extends AudioNode>(node: T): T => {
      node.channelCount = channels; node.channelCountMode = 'explicit'; node.channelInterpretation = 'discrete'; return node
    }
    const gain = (): GainNode => configure(context.createGain())
    this.input = gain(); this.output = gain(); this.dry = gain()
    this.firstGain = gain(); this.secondGain = gain()
    this.firstGain.gain.value = 0; this.secondGain.gain.value = 0
    this.firstHeadroom = gain(); this.secondHeadroom = gain()
    this.input.connect(this.dry).connect(this.output)
    const bank = (count: number, headroom: GainNode, wet: GainNode): BiquadFilterNode[] => {
      const filters = Array.from({ length: count }, () => { const node = configure(context.createBiquadFilter()); node.type = 'peaking'; return node })
      this.input.connect(headroom)
      let tail: AudioNode = headroom
      for (const filter of filters) { tail.connect(filter); tail = filter }
      tail.connect(wet).connect(this.output)
      return filters
    }
    this.firstBank = bank(10, this.firstHeadroom, this.firstGain)
    this.secondBank = bank(10, this.secondHeadroom, this.secondGain)
  }

  apply(configuration: EqConfiguration, immediate = false): void {
    this.pending = configuration
    if (immediate) this.transitionEnd = 0
    this.flush(immediate)
  }

  private flush(immediate = false): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (!this.pending) return
    const now = this.context.currentTime
    if (!immediate && now < this.transitionEnd) {
      this.timer = setTimeout(() => this.flush(), Math.max(1, Math.ceil((this.transitionEnd - now) * 1000)))
      return
    }
    const configuration = this.pending; this.pending = null
    const { state } = configuration
    const next = this.activeBank === 0 ? 1 : 0
    const filters = next === 0 ? this.firstBank : this.secondBank
    const headroom = next === 0 ? this.firstHeadroom : this.secondHeadroom
    const wet = next === 0 ? this.firstGain : this.secondGain
    const previous = this.activeBank < 0 ? this.dry : this.activeBank === 0 ? this.firstGain : this.secondGain
    const bands = state.enabled ? state.mode === 'graphic' ? configuration.graphic : configuration.parametric : []
    // Only replace the silent bank. Web Audio exposes no biquad-state reset;
    // reusing a filter's delay state with new coefficients can cause a burst.
    // The audible bank remains connected throughout the change.
    headroom.disconnect(filters[0]!)
    for (const filter of filters) filter.disconnect()
    filters.splice(0, filters.length, ...Array.from({ length: 10 }, () => {
      const filter = this.context.createBiquadFilter()
      filter.type = 'peaking'; filter.channelCount = this.channels
      filter.channelCountMode = 'explicit'; filter.channelInterpretation = 'discrete'
      return filter
    }))
    let tail: AudioNode = headroom
    for (const filter of filters) { tail.connect(filter); tail = filter }
    tail.connect(wet)
    filters.forEach((filter, index) => {
      const band = bands[index]
      filter.frequency.value = band?.frequency ?? 1000
      filter.gain.value = band?.gainDb ?? 0
      filter.Q.value = band?.q ?? 1
    })
    headroom.gain.value = state.enabled ? 10 ** ((state.mode === 'graphic' ? configuration.graphicCompensation : configuration.parametricCompensation) / 20) : 1
    const start = now + (immediate ? 0 : .01), end = start + (immediate ? 0 : .03)
    wet.gain.cancelScheduledValues(now); wet.gain.setValueAtTime(0, now); wet.gain.setValueAtTime(0, start); wet.gain.linearRampToValueAtTime(1, end)
    previous.gain.cancelScheduledValues(now); previous.gain.setValueAtTime(1, now); previous.gain.setValueAtTime(1, start); previous.gain.linearRampToValueAtTime(0, end)
    if (immediate) {
      this.dry.gain.cancelScheduledValues(now); this.dry.gain.setValueAtTime(0, now)
      const other = next === 0 ? this.secondGain : this.firstGain
      other.gain.cancelScheduledValues(now); other.gain.setValueAtTime(0, now)
    }
    // Let the zero-gain endpoint render before recycling that bank. Cancelling
    // its ramp exactly at the endpoint can expose one quantum of stale audio.
    this.activeBank = next; this.transitionEnd = end + (immediate ? 0 : 256 / this.context.sampleRate)
  }

  setSpectrumActive(active: boolean): void {
    if (active === Boolean(this.splitter)) return
    if (!active) {
      if (this.splitter) this.output.disconnect(this.splitter)
      this.splitter?.disconnect(); this.splitter = null
      for (const { node } of this.analysers) node.disconnect()
      this.analysers = []
      return
    }
    this.splitter = this.context.createChannelSplitter(this.channels)
    this.output.connect(this.splitter)
    this.analysers = Array.from({ length: this.channels }, (_, index) => {
      const node = this.context.createAnalyser()
      node.fftSize = EQ_FFT_SIZE; node.smoothingTimeConstant = 0.65; node.minDecibels = -100; node.maxDecibels = 0
      this.splitter!.connect(node, index)
      return { node, data: new Float32Array(node.frequencyBinCount) }
    })
  }

  accumulateSpectrum(power: Float32Array<ArrayBuffer>): number {
    for (const { node, data } of this.analysers) {
      node.getFloatFrequencyData(data)
      for (let index = 0; index < power.length; index++) power[index]! += Number.isFinite(data[index]) ? 10 ** (data[index]! / 10) : 0
    }
    return this.analysers.length
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null; this.pending = null
    this.setSpectrumActive(false)
    for (const node of [this.input, this.output, this.dry, ...this.firstBank, ...this.secondBank, this.firstGain, this.secondGain, this.firstHeadroom, this.secondHeadroom]) node.disconnect()
  }
}
