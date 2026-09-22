import { setAudioContextOutputDevice } from '../audio-engine.js'
import { frequency, CHORDS } from './theory.js'
import { beatUnit, meterLength, progression, type GeneratedExercise } from './generator.js'
import type { ExerciseConfig, MusicEvent } from './types.js'
export interface TransportFrame {
  playing: boolean
  eventId: string | null
  beat: number
  bar: number
  round: number
  bpm: number
  countIn: number
  hidden: boolean
}
export const IDLE_FRAME: TransportFrame = {
  playing: false,
  eventId: null,
  beat: 0,
  bar: 1,
  round: 1,
  bpm: 70,
  countIn: 0,
  hidden: false
}
export function swingBeat(beat: number, config: ExerciseConfig): number {
  const unit = beatUnit(config.meter)
  const phase = beat / unit
  const base = Math.floor(phase + 1e-9)
  const fraction = phase - base
  if (config.subdivision !== 2) return beat
  return (
    (base +
      (fraction <= 0.5 ? fraction * config.swing * 2 : config.swing + (fraction - 0.5) * (1 - config.swing) * 2)) *
    unit
  )
}
/** One audio clock owns notes, backing and cursor. JS only fills the look-ahead queue. */
export class WoodshedAudio {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private sources = new Set<AudioScheduledSourceNode>()
  private timer: ReturnType<typeof setInterval> | null = null
  private animation = 0
  private generation = 0
  private disposed = false
  private origin = 0
  private scheduled = 0
  private elapsed = 0
  private config: ExerciseConfig | null = null
  private exercise: GeneratedExercise | null = null
  private active = false
  private metronomeOnly = false
  private frameListener: (frame: TransportFrame) => void = () => {}
  private queue: { time: number; frame: TransportFrame }[] = []
  private output = ''
  private droneNodes: OscillatorNode[] = []
  private currentFrame = { ...IDLE_FRAME }
  private a4 = 440
  onFrame(listener: (frame: TransportFrame) => void): void {
    this.frameListener = listener
  }
  async setOutput(id: string): Promise<void> {
    this.output = id
    if (this.context) await setAudioContextOutputDevice(this.context, id)
  }
  setReference(a4: number): void {
    this.a4 = a4
  }
  private async ready(): Promise<AudioContext> {
    if (this.disposed) throw new Error('练功房已关闭')
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.context.createGain()
      this.master.gain.value = 0.6
      this.master.connect(this.context.destination)
    }
    const context = this.context
    await setAudioContextOutputDevice(context, this.output)
    if (context.state === 'suspended') await context.resume()
    if (this.disposed) throw new Error('练功房已关闭')
    return context
  }
  private tone(
    midi: number,
    time: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'triangle',
    bend = 0
  ): void {
    if (!this.context || !this.master || gain <= 0) return
    const osc = this.context.createOscillator(),
      envelope = this.context.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(frequency(midi, this.a4), time)
    if (bend) osc.frequency.exponentialRampToValueAtTime(frequency(midi + bend, this.a4), time + duration * 0.65)
    envelope.gain.setValueAtTime(0, time)
    envelope.gain.linearRampToValueAtTime(gain, time + 0.008)
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.025, duration))
    osc.connect(envelope)
    envelope.connect(this.master)
    osc.start(time)
    osc.stop(time + Math.max(0.03, duration) + 0.02)
    this.sources.add(osc)
    osc.onended = () => {
      this.sources.delete(osc)
      osc.disconnect()
      envelope.disconnect()
    }
  }
  async preview(midi: number): Promise<void> {
    const token = this.generation
    const context = await this.ready()
    if (token === this.generation) this.tone(midi, context.currentTime, 0.8, 0.22)
  }
  async drone(root: number, fifth: boolean): Promise<void> {
    this.stop()
    const token = this.generation
    const context = await this.ready()
    if (token !== this.generation) return
    for (const midi of fifth ? [48 + root, 55 + root] : [48 + root]) {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.frequency.value = frequency(midi, this.a4)
      gain.gain.value = 0.09
      osc.type = 'sine'
      osc.connect(gain)
      gain.connect(this.master!)
      osc.start()
      this.droneNodes.push(osc)
      this.sources.add(osc)
      osc.onended = () => {
        this.sources.delete(osc)
        osc.disconnect()
        gain.disconnect()
      }
    }
  }
  stop(): void {
    this.generation++
    this.active = false
    this.elapsed = 0
    this.scheduled = 0
    this.queue = []
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    cancelAnimationFrame(this.animation)
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear()
    this.droneNodes = []
    this.currentFrame = { ...IDLE_FRAME }
    this.frameListener(this.currentFrame)
  }
  pause(): void {
    if (!this.active || !this.context) return
    const elapsed = this.context.currentTime - this.origin
    const frame = this.currentFrame
    this.stop()
    this.elapsed = elapsed
    this.currentFrame = { ...frame, playing: false }
    this.frameListener(this.currentFrame)
  }
  async play(
    exercise: GeneratedExercise,
    config: ExerciseConfig,
    metronomeOnly = false,
    resume = false
  ): Promise<void> {
    const saved = resume ? this.elapsed : 0
    this.stop()
    this.elapsed = saved
    const token = this.generation
    const context = await this.ready()
    if (token !== this.generation) return
    this.config = { ...config }
    this.exercise = exercise
    this.metronomeOnly = metronomeOnly
    this.origin = context.currentTime + 0.06 - saved
    this.active = true
    this.scheduled = 0
    this.queue = []
    const run = () => this.schedule()
    run()
    this.timer = setInterval(run, 25)
    const draw = () => {
      if (!this.active || !this.context) return
      while (this.queue.length && this.queue[0]!.time <= this.context.currentTime) {
        this.currentFrame = this.queue.shift()!.frame
        this.frameListener(this.currentFrame)
      }
      this.animation = requestAnimationFrame(draw)
    }
    draw()
  }
  private schedule(): void {
    const context = this.context,
      c = this.config,
      exercise = this.exercise
    if (!context || !c || !exercise || !this.active) return
    const length = meterLength(c.meter),
      unit = beatUnit(c.meter)
    const from = Math.min(Math.max(0, (c.loopStart - 1) * length), exercise.beats - length)
    const to = c.loopEnd > 0 ? Math.min(exercise.beats, Math.max(from + length, c.loopEnd * length)) : exercise.beats
    const loopBeats = to - from
    const tick = unit / 12
    const countBeats = c.countIn * length
    const countSeconds = ((countBeats / unit) * 60) / c.bpm
    let safety = 0
    while (safety++ < 1000) {
      const absolute = this.scheduled * tick
      let seconds: number,
        round = 0,
        bpm = c.bpm,
        local = 0,
        inCount = absolute < countBeats - 1e-8
      if (inCount) {
        local = absolute
        seconds = ((absolute / unit) * 60) / bpm
      } else {
        const passed = absolute - countBeats
        round = Math.floor((passed + 1e-7) / loopBeats)
        local = passed - round * loopBeats + from
        seconds = countSeconds
        for (let r = 0; r < round; r++) seconds += ((loopBeats / unit) * 60) / Math.min(240, c.bpm + r * c.speedStep)
        bpm = Math.min(240, c.bpm + round * c.speedStep)
        seconds += ((swingBeat(local - from, c) / unit) * 60) / bpm
      }
      const time = this.origin + seconds
      if (time > context.currentTime + 0.12) break
      this.scheduled++
      if (time < context.currentTime - 0.005) continue
      if (!inCount && c.rounds > 0 && round >= c.rounds) {
        this.queue.push({ time, frame: { ...this.currentFrame, playing: false, eventId: null } })
        this.active = false
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        const token = this.generation
        setTimeout(
          () => {
            if (!this.disposed && this.generation === token) this.stop()
          },
          Math.max(0, (time - context.currentTime) * 1000)
        )
        break
      }
      const bar = Math.floor((local + 1e-7) / length)
      const barBeat = local - bar * length
      const silent = !inCount && c.silentBars > 0 && bar % (c.silentBars + 1) !== 0
      const onPulse = Math.abs(barBeat / unit - Math.round(barBeat / unit)) < 1e-5
      const onSubdivision =
        Math.abs(barBeat / (unit / c.subdivision) - Math.round(barBeat / (unit / c.subdivision))) < 1e-5
      if (!onPulse && onSubdivision && !inCount && !silent && !c.backbeat) this.tone(72, time, 0.025, 0.055, 'sine')
      if (onPulse) {
        const pulse = Math.round(barBeat / unit)
        const click = inCount || (!silent && (!c.backbeat || pulse === 1 || pulse === 3))
        if (click) this.tone(pulse === 0 ? 91 : 79, time, 0.055, 0.18, 'sine')
        this.queue.push({
          time,
          frame: {
            playing: true,
            eventId: null,
            beat: local,
            bar: bar + 1,
            round: round + 1,
            bpm,
            countIn: inCount ? Math.ceil((countBeats - local) / unit) : 0,
            hidden: silent || c.hint === 'none'
          }
        })
      }
      if (!inCount) {
        for (let index = 0; index < exercise.events.length; index++) {
          const event = exercise.events[index]!
          if (Math.abs(event.beat - local) > 1e-5) continue
          this.queue.push({
            time,
            frame: {
              playing: true,
              eventId: silent ? null : event.id,
              beat: local,
              bar: bar + 1,
              round: round + 1,
              bpm,
              countIn: 0,
              hidden: silent || c.hint === 'none'
            }
          })
          let duration = event.duration
          if (!event.tie) {
            // A tie sustains the original attack; it does not drop the continuation or retrigger it.
            for (let next = index + 1; next < exercise.events.length; next++) {
              const continuation = exercise.events[next]!
              if (!continuation.tie || continuation.beat >= to) break
              duration += continuation.duration
            }
          }
          if (!this.metronomeOnly && c.mode === 'demo' && !silent)
            this.noteEvent(event, time, (((swingBeat(local + duration, c) - swingBeat(local, c)) / unit) * 60) / bpm)
        }
        if (!this.metronomeOnly && c.mode === 'apply' && onPulse && !silent) {
          const chords = progression(c.backing, c.root)
          const chord = chords[bar % chords.length]!
          const pulse = Math.round(barBeat / unit)
          const beatSeconds = 60 / bpm
          if (c.drums > 0) this.tone(pulse % 2 ? 55 : 31, time, 0.07, c.drums * 0.26, 'triangle')
          if (c.bass > 0) this.tone(36 + chord.root + (pulse % 2 ? 7 : 0), time, beatSeconds * 0.8, c.bass * 0.26)
          if (pulse === 0 && c.harmony > 0) {
            const quality = c.backing === 'drone' ? CHORDS[c.chord]! : CHORDS[chord.quality]!
            for (const interval of quality.semitones)
              this.tone(48 + chord.root + interval, time, (length / unit) * beatSeconds * 0.9, c.harmony * 0.09, 'sine')
          }
        }
      }
    }
    this.queue.sort((a, b) => a.time - b.time)
  }
  private noteEvent(event: MusicEvent, time: number, duration: number): void {
    if (event.tie) return
    event.notes.forEach((note, i) =>
      this.tone(
        note.midi,
        time + (event.technique === 'down' ? i * 0.015 : 0),
        Math.max(0.035, duration * 0.88),
        event.technique === 'mute' ? 0.035 : 0.24 / Math.sqrt(event.notes.length),
        event.technique === 'mute' ? 'square' : 'triangle',
        event.bend ?? 0
      )
    )
  }
  destroy(): void {
    this.stop()
    this.disposed = true
    void this.context?.close()
    this.context = null
  }
}
