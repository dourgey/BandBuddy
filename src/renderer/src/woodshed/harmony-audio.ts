import { setAudioContextOutputDevice } from '../audio-engine.js'
import { frequency } from './theory.js'

export interface HarmonyStep { notes: number[]; beats: number }
/** Audio-time scheduling keeps chord changes and their visual cursor on one clock. */
export class HarmonyAudio {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private sources = new Set<OscillatorNode>()
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private disposed = false
  private output = ''
  private volume = 0.5
  private a4 = 440
  async setOutput(id: string): Promise<void> {
    this.output = id
    if (this.context) await setAudioContextOutputDevice(this.context, id)
  }
  configure(volume: number, a4: number): void {
    this.volume = volume; this.a4 = a4
    if (this.context && this.master) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.02)
  }
  private async ready(): Promise<AudioContext> {
    if (this.disposed) throw new Error('和声播放器已关闭')
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.context.createGain(); this.master.gain.value = this.volume
      this.master.connect(this.context.destination)
    }
    await setAudioContextOutputDevice(this.context, this.output)
    await this.context.resume()
    return this.context
  }
  private tone(midi: number, at: number, duration: number, voices: number): void {
    const context = this.context!
    const source = context.createOscillator(), gain = context.createGain()
    source.type = 'triangle'; source.frequency.value = frequency(midi, this.a4)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.28 / Math.sqrt(voices), at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    source.connect(gain); gain.connect(this.master!)
    this.sources.add(source)
    source.onended = () => { this.sources.delete(source); source.disconnect(); gain.disconnect() }
    source.start(at); source.stop(at + duration + 0.02)
  }
  async preview(notes: number[]): Promise<void> {
    const token = this.generation, context = await this.ready()
    if (this.disposed || token !== this.generation) return
    notes.forEach(n => this.tone(n, context.currentTime, 0.9, notes.length))
  }
  async play(steps: HarmonyStep[], bpm: number, loop: boolean, onStep: (index: number) => void, onEnd: () => void): Promise<void> {
    this.stop()
    const token = this.generation, context = await this.ready()
    if (this.disposed || token !== this.generation || !steps.length) return
    let next = context.currentTime + 0.04, index = 0, finished = false
    const queue: { at: number; index: number }[] = []
    const tick = (): void => {
      while (!finished && next < context.currentTime + 0.12) {
        const step = steps[index]!, duration = step.beats * 60 / bpm
        step.notes.forEach(n => this.tone(n, next, Math.max(0.1, duration * 0.9), step.notes.length))
        queue.push({ at: next, index }); next += duration; index++
        if (index === steps.length) { if (loop) index = 0; else finished = true }
      }
      while (queue.length && queue[0]!.at <= context.currentTime) onStep(queue.shift()!.index)
      if (finished && context.currentTime >= next) { this.stop(); onEnd() }
    }
    tick(); this.timer = setInterval(tick, 25)
  }
  stop(): void {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.sources.forEach(source => { try { source.stop() } catch { /* ended */ } })
    this.sources.clear()
  }
  destroy(): void { this.disposed = true; this.stop(); void this.context?.close() }
}
