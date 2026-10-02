import { claimAudioSession, releaseAudioSession } from '../audio-session.js'
import { allowAudioAction } from '../recording-session.js'
import { setAudioContextOutputDevice } from '../audio-engine.js'

export interface MetronomeSettings {
  bpm: number
  beats: number
  denominator: number
  subdivision: number
  accent: boolean
  sound: 'wood' | 'click' | 'bell'
  volume: number
  countIn: number
  speedStep: number
  silentBars: number
}
export const DEFAULT_METRONOME: MetronomeSettings = {
  bpm: 120, beats: 4, denominator: 4, subdivision: 1, accent: true,
  sound: 'wood', volume: 0.65, countIn: 0, speedStep: 0, silentBars: 0
}
export const clampBpm = (value: number): number => Math.max(30, Math.min(240, Math.round(value)))
export function readMetronome(): MetronomeSettings {
  try {
    const data = JSON.parse(localStorage.getItem('bandbuddy.metronome.v1') ?? '{}')
    const result = { ...DEFAULT_METRONOME }
    for (const [key, min, max] of [['bpm', 30, 240], ['beats', 1, 12], ['subdivision', 1, 4], ['volume', 0, 1], ['countIn', 0, 4], ['speedStep', 0, 10], ['silentBars', 0, 8]] as const) {
      if (typeof data[key] === 'number' && Number.isFinite(data[key])) result[key] = Math.max(min, Math.min(max, key === 'volume' ? data[key] : Math.round(data[key])))
    }
    if ([2, 4, 8, 16].includes(data.denominator)) result.denominator = data.denominator
    if (typeof data.accent === 'boolean') result.accent = data.accent
    if (['wood', 'click', 'bell'].includes(data.sound)) result.sound = data.sound
    return result
  } catch { return { ...DEFAULT_METRONOME } }
}
export interface MetronomePulse { time: number; duration: number; index: number; beat: number; bpm: number; countIn: boolean; silent: boolean }

/** Audio-clock lookahead; visual motion consumes the very same scheduled pulse times. */
export class MetronomeEngine {
  private audioSession: number | undefined
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private sources = new Set<OscillatorNode>()
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private nextTime = 0
  private index = 0
  private settings = { ...DEFAULT_METRONOME }
  private pulses: MetronomePulse[] = []
  private output = ''
  private disposed = false
  get now(): number {
    const context = this.context
    if (!context) return 0
    const timestamp = context.getOutputTimestamp?.()
    return timestamp?.contextTime ? timestamp.contextTime : Math.max(0, context.currentTime - (context.outputLatency || 0))
  }
  async setOutput(id: string): Promise<void> {
    this.output = id
    if (this.context) await setAudioContextOutputDevice(this.context, id)
  }
  update(settings: MetronomeSettings): void {
    this.settings = { ...settings }
    if (this.master && this.context) this.master.gain.setTargetAtTime(settings.volume, this.context.currentTime, 0.01)
  }
  async start(settings: MetronomeSettings): Promise<boolean> {
    this.stop()
    if (this.disposed || !allowAudioAction()) return false
    this.audioSession = claimAudioSession('woodshed', '节拍器', () => this.stop())
    const token = this.generation
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.context.createGain()
      this.master.connect(this.context.destination)
    }
    await setAudioContextOutputDevice(this.context, this.output)
    await this.context.resume()
    if (this.disposed || token !== this.generation) return false
    this.update(settings)
    this.nextTime = this.context.currentTime + 0.06
    this.index = 0
    this.schedule()
    this.timer = setInterval(() => this.schedule(), 25)
    return true
  }
  pulse(): MetronomePulse | null {
    while (this.pulses.length > 1 && this.pulses[1]!.time <= this.now) this.pulses.shift()
    return this.pulses[0] && this.pulses[0].time <= this.now ? this.pulses[0] : null
  }
  private schedule(): void {
    const context = this.context
    if (!context) return
    // Keep the visual queue bounded even when requestAnimationFrame is paused in the background.
    while (this.pulses.length > 2 && this.pulses[1]!.time < this.now) this.pulses.shift()
    // After a suspended/background renderer, resume on the next beat without a burst of stale clicks.
    if (this.nextTime < context.currentTime - 0.1) this.nextTime = context.currentTime + 0.025
    while (this.nextTime < context.currentTime + 0.12) {
      const c = this.settings
      const countIn = this.index < c.countIn * c.beats
      const bar = Math.max(0, Math.floor(this.index / c.beats) - c.countIn)
      const bpm = clampBpm(c.bpm + Math.floor(bar / 4) * c.speedStep)
      const duration = 60 / bpm
      const beat = this.index % c.beats
      const silent = !countIn && c.silentBars > 0 && bar % (c.silentBars + 1) !== 0
      this.pulses.push({ time: this.nextTime, duration, index: this.index, beat, bpm, countIn, silent })
      if (!silent) for (let sub = 0; sub < (countIn ? 1 : c.subdivision); sub++) {
        this.click(this.nextTime + sub * duration / c.subdivision, sub === 0 && beat === 0 && c.accent, sub !== 0)
      }
      this.nextTime += duration
      this.index++
    }
  }
  private click(time: number, accent: boolean, subdivision: boolean): void {
    const context = this.context!
    const osc = context.createOscillator(), envelope = context.createGain()
    const sound = this.settings.sound
    const frequency = (sound === 'wood' ? 950 : sound === 'bell' ? 1500 : 1900) * (accent ? 1.5 : 1)
    osc.type = sound === 'wood' ? 'triangle' : 'sine'
    osc.frequency.setValueAtTime(frequency, time)
    osc.frequency.exponentialRampToValueAtTime(frequency * (sound === 'wood' ? 0.5 : 0.95), time + 0.035)
    envelope.gain.setValueAtTime(0, time)
    envelope.gain.linearRampToValueAtTime(subdivision ? 0.09 : accent ? 0.38 : 0.25, time + 0.002)
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + (sound === 'bell' ? 0.11 : 0.045))
    osc.connect(envelope); envelope.connect(this.master!)
    osc.start(time); osc.stop(time + 0.13)
    this.sources.add(osc)
    osc.onended = () => { this.sources.delete(osc); osc.disconnect(); envelope.disconnect() }
  }
  stop(): void {
   if (this.audioSession !== undefined) releaseAudioSession('woodshed', this.audioSession)
   this.audioSession = undefined
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const source of this.sources) { source.stop(); source.disconnect() }
    this.sources.clear()
    this.pulses = []
  }
  destroy(): void { this.stop(); this.disposed = true; void this.context?.close(); this.context = null }
}
