import { setAudioContextOutputDevice } from '../audio-engine.js'
import { frequency } from './theory.js'
import { envelopeAt, type LabEvent, type SynthPatch } from './ensemble.js'
interface VisualFrame {
  time: number
  event: LabEvent | null
  round: number
  count: number
}
/** Local instrument demonstrations. The audio clock owns timing; UI consumes the same events. */
export class EnsembleAudio {
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null
  private sources = new Set<AudioScheduledSourceNode>()
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private visualActive = true
  private playing = false
  private visualQueue: VisualFrame[] = []
  private currentVisualFrame: VisualFrame | null = null
  private frameListener: (event: LabEvent | null, round: number, count: number) => void = () => {}
  private generation = 0
  private disposed = false
  private output = ''
  setVisualActive(active: boolean): void {
    if (this.visualActive === active || this.disposed) return
    this.visualActive = active
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.consumeFrames(false)
    if (active && this.playing) {
      const latest = this.currentVisualFrame
      if (latest) this.frameListener(latest.event, latest.round, latest.count)
      this.animate()
    }
  }
  private consumeFrames(notify: boolean): void {
    if (!this.ctx) return
    while (this.visualQueue.length && this.visualQueue[0]!.time <= this.ctx.currentTime) {
      const latest = this.visualQueue.shift()!
      this.currentVisualFrame = latest
      if (notify) this.frameListener(latest.event, latest.round, latest.count)
    }
  }
  private animate = (): void => {
    if (!this.playing || !this.visualActive || this.disposed) return
    this.consumeFrames(true)
    this.frame = requestAnimationFrame(this.animate)
  }
  async setOutput(id: string): Promise<void> {
    this.output = id
    if (this.ctx) await setAudioContextOutputDevice(this.ctx, id)
  }
  private async ready(): Promise<AudioContext> {
    if (this.disposed) throw new Error('工作区已关闭')
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.bus = this.ctx.createGain()
      this.bus.gain.value = 0.24
      this.bus.connect(this.ctx.destination)
    }
    const ctx = this.ctx
    await setAudioContextOutputDevice(ctx, this.output)
    if (ctx.state === 'suspended') await ctx.resume()
    return ctx
  }
  private track(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
      nodes.forEach((n) => n.disconnect())
    }
  }
  private sound(event: LabEvent, time: number, seconds: number, a4: number, patch?: SynthPatch): void {
    if (event.pitches) {
      event.pitches.forEach((midi) =>
        this.sound(
          {
            ...event,
            pitches: undefined,
            midi,
            velocity: event.velocity / Math.sqrt(Math.max(1, event.pitches!.length))
          },
          time,
          seconds,
          a4,
          patch
        )
      )
      return
    }
    const ctx = this.ctx!,
      gain = ctx.createGain()
    gain.connect(this.bus!)
    if (event.voice === 'snare' || event.voice === 'hat') {
      const source = ctx.createBufferSource(),
        filter = ctx.createBiquadFilter(),
        length = event.voice === 'hat' ? 0.055 : 0.14
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate),
        data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      source.buffer = buffer
      filter.type = 'highpass'
      filter.frequency.value = event.voice === 'hat' ? 6500 : 1500
      source.connect(filter)
      filter.connect(gain)
      gain.gain.setValueAtTime(event.velocity, time)
      gain.gain.exponentialRampToValueAtTime(0.001, time + length)
      this.track(source, [gain, filter])
      source.start(time)
      source.stop(time + length)
      return
    }
    const osc = ctx.createOscillator()
    if (event.voice) {
      osc.type = event.voice === 'kick' ? 'sine' : 'triangle'
      osc.frequency.setValueAtTime(event.voice === 'kick' ? 130 : 1100, time)
      if (event.voice === 'kick') osc.frequency.exponentialRampToValueAtTime(45, time + 0.12)
      osc.connect(gain)
      gain.gain.setValueAtTime(event.velocity, time)
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15)
      this.track(osc, [gain])
      osc.start(time)
      osc.stop(time + 0.17)
      return
    }
    osc.frequency.value = frequency(event.midi ?? 69, a4)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = patch?.cutoff ?? 8000
    filter.Q.value = patch?.resonance ?? 0.7
    osc.type = patch?.wave ?? 'triangle'
    osc.connect(filter)
    filter.connect(gain)
    const amp = event.velocity * 0.55,
      gate = seconds
    if (patch) {
      gain.gain.setValueAtTime(0, time)
      if (gate > patch.attack) gain.gain.linearRampToValueAtTime(amp, time + patch.attack)
      if (gate > patch.attack + patch.decay)
        gain.gain.linearRampToValueAtTime(amp * patch.sustain, time + patch.attack + patch.decay)
      gain.gain.linearRampToValueAtTime(amp * envelopeAt(gate, gate, patch), time + gate)
      gain.gain.linearRampToValueAtTime(0, time + gate + patch.release)
      if (patch.lfo > 0 && patch.depth > 0) {
        const lfo = ctx.createOscillator(),
          depth = ctx.createGain()
        lfo.frequency.value = patch.lfo
        depth.gain.value = patch.depth
        lfo.connect(depth)
        depth.connect(osc.detune)
        this.track(lfo, [depth])
        lfo.start(time)
        lfo.stop(time + gate + patch.release)
      }
    } else if (event.timbre === 'piano') {
      filter.frequency.value = 3500
      gain.gain.setValueAtTime(0, time)
      gain.gain.linearRampToValueAtTime(amp, time + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.001, time + Math.max(0.04, gate))
    } else {
      gain.gain.setValueAtTime(0, time)
      gain.gain.linearRampToValueAtTime(amp, time + 0.015)
      gain.gain.setValueAtTime(amp, time + Math.max(0.02, gate - 0.04))
      gain.gain.linearRampToValueAtTime(0, time + gate)
    }
    this.track(osc, [gain, filter])
    osc.start(time)
    osc.stop(time + gate + (patch?.release ?? 0.02))
  }
  stop(): void {
    this.generation++
    this.playing = false
    this.visualQueue = []
    this.currentVisualFrame = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.sources.forEach((s) => {
      try {
        s.stop()
      } catch {
        /* Already ended. */
      }
    })
    this.sources.clear()
  }
  async preview(midi: number, a4: number, patch?: SynthPatch): Promise<void> {
    this.stop()
    const token = this.generation,
      ctx = await this.ready()
    if (token !== this.generation || this.disposed) return
    this.sound(
      { beat: 0, duration: 1, midi, velocity: 0.7, step: 0 },
      ctx.currentTime + 0.01,
      patch?.gate ?? 0.7,
      a4,
      patch
    )
  }
  async previewChord(pitches: number[], a4: number): Promise<void> {
    this.stop()
    const token = this.generation,
      ctx = await this.ready()
    if (token !== this.generation || this.disposed) return
    this.sound(
      { beat: 0, duration: 1, pitches, velocity: 0.8, step: 0, timbre: 'piano' },
      ctx.currentTime + 0.01,
      1.2,
      a4
    )
  }
  async play(
    events: LabEvent[],
    beats: number,
    bpm: number,
    rounds: number,
    a4: number,
    onFrame: (event: LabEvent | null, round: number, count: number) => void,
    onEnd: () => void
  ): Promise<void> {
    this.stop()
    const token = this.generation,
      ctx = await this.ready()
    if (token !== this.generation || this.disposed) return
    const seconds = 60 / bpm,
      origin = ctx.currentTime + 0.06,
      countIn = 4
    let round = -1,
      index = 0
    this.playing = true
    this.frameListener = onFrame
    const clicks = Array.from(
      { length: 4 },
      (_, step): LabEvent => ({ beat: step, duration: 0.1, voice: 'click', velocity: step === 0 ? 0.65 : 0.4, step })
    )
    const schedule = () => {
      if (token !== this.generation || !this.playing) return
      if (rounds > 0 && ctx.currentTime >= origin + (countIn + rounds * beats) * seconds + 0.05) {
        this.stop()
        onEnd()
        return
      }
      while (rounds === 0 || round < rounds) {
        const list = round === -1 ? clicks : events
        if (!list.length) {
          this.stop()
          onEnd()
          return
        }
        const event = list[index]!,
          at = origin + (round === -1 ? event.beat : countIn + round * beats + event.beat) * seconds
        if (at > ctx.currentTime + 0.12) break
        if (at >= ctx.currentTime - 0.02) {
          this.sound(event, Math.max(at, ctx.currentTime), event.duration * seconds, a4)
          this.visualQueue.push({
            time: at,
            event: round === -1 ? null : event,
            round: round + 1,
            count: round === -1 ? index + 1 : 0
          })
        }
        index++
        if (index === list.length) {
          index = 0
          round++
        }
      }
      if (!this.visualActive) this.consumeFrames(false)
    }
    schedule()
    if (token !== this.generation || !this.playing) return
    this.timer = setInterval(schedule, 25)
    this.animate()
  }
  destroy(): void {
    this.disposed = true
    this.stop()
    void this.ctx?.close()
    this.ctx = null
  }
}
