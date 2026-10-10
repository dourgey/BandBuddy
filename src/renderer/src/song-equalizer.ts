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

function ramp(parameter: AudioParam, value: number, now: number, seconds: number, exponential = false): void {
  if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(now)
  else { parameter.cancelScheduledValues(now); parameter.setValueAtTime(parameter.value, now) }
  if (exponential) parameter.exponentialRampToValueAtTime(value, now + seconds)
  else parameter.linearRampToValueAtTime(value, now + seconds)
}

/** Discrete channels are filtered independently; no speaker-layout downmix enters the output. */
export class SongEqBus {
  readonly input: GainNode
  readonly output: GainNode
  private readonly dry: GainNode
  private readonly graphic: BiquadFilterNode[]
  private readonly parametric: BiquadFilterNode[]
  private readonly graphicGain: GainNode
  private readonly parametricGain: GainNode
  private readonly graphicHeadroom: GainNode
  private readonly parametricHeadroom: GainNode
  private splitter: ChannelSplitterNode | null = null
  private analysers: Array<{ node: AnalyserNode; data: Float32Array<ArrayBuffer> }> = []
  private previousMode: string | null = null

  constructor(private readonly context: BaseAudioContext, private readonly channels: number) {
    const configure = <T extends AudioNode>(node: T): T => {
      node.channelCount = channels; node.channelCountMode = 'explicit'; node.channelInterpretation = 'discrete'; return node
    }
    const gain = (): GainNode => configure(context.createGain())
    this.input = gain(); this.output = gain(); this.dry = gain()
    this.graphicGain = gain(); this.parametricGain = gain()
    this.graphicGain.gain.value = 0; this.parametricGain.gain.value = 0
    this.graphicHeadroom = gain(); this.parametricHeadroom = gain()
    this.input.connect(this.dry).connect(this.output)
    const bank = (count: number, headroom: GainNode, wet: GainNode): BiquadFilterNode[] => {
      const filters = Array.from({ length: count }, () => { const node = configure(context.createBiquadFilter()); node.type = 'peaking'; return node })
      let tail: AudioNode = this.input
      for (const filter of filters) { tail.connect(filter); tail = filter }
      tail.connect(headroom).connect(wet).connect(this.output)
      return filters
    }
    this.graphic = bank(10, this.graphicHeadroom, this.graphicGain)
    this.parametric = bank(EQ_MAX_NODES, this.parametricHeadroom, this.parametricGain)
  }

  apply(configuration: EqConfiguration, immediate = false): void {
    const { state, graphic, parametric } = configuration
    const now = this.context.currentTime, parameterRamp = immediate ? 0 : 0.03
    const mode = state.enabled ? state.mode : 'off'
    const transition = immediate ? 0 : this.previousMode !== mode ? 0.05 : 0.03
    const applyBands = (filters: BiquadFilterNode[], bands: Band[]): void => filters.forEach((filter, index) => {
      const band = bands[index]!
      ramp(filter.frequency, band.frequency, now, parameterRamp)
      ramp(filter.gain, band.gainDb, now, parameterRamp)
      ramp(filter.Q, band.q, now, parameterRamp)
    })
    applyBands(this.graphic, graphic); applyBands(this.parametric, parametric)
    // Gain compensation moves in dB with the filter gains, avoiding a transient
    // level boost caused by a linear amplitude ramp during a boost adjustment.
    ramp(this.graphicHeadroom.gain, 10 ** (configuration.graphicCompensation / 20), now, parameterRamp, true)
    ramp(this.parametricHeadroom.gain, 10 ** (configuration.parametricCompensation / 20), now, parameterRamp, true)
    ramp(this.dry.gain, mode === 'off' ? 1 : 0, now, transition)
    ramp(this.graphicGain.gain, mode === 'graphic' ? 1 : 0, now, transition)
    ramp(this.parametricGain.gain, mode === 'parametric' ? 1 : 0, now, transition)
    this.previousMode = mode
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
    this.setSpectrumActive(false)
    for (const node of [this.input, this.output, this.dry, ...this.graphic, ...this.parametric, this.graphicGain, this.parametricGain, this.graphicHeadroom, this.parametricHeadroom]) node.disconnect()
  }
}
