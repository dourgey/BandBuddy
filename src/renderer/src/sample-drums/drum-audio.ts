import { claimAudioSession, releaseAudioSession } from '../audio-session.js'
import { allowAudioAction } from '../recording-session.js'
import { setAudioContextOutputDevice } from '../audio-engine.js'
import { CLOSED_HATS, OPEN_HATS, drumStepTime, stepCount, type DrumDraft, type DrumSample } from './drum-patterns.js'

/** A look-ahead queue schedules samples on the audio clock, including cursor and pad capture. */
export class DrumAudio {
  private audioSession: number | undefined
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private buffers = new Map<number, Promise<AudioBuffer>>()
  private voices = new Map<AudioBufferSourceNode, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private animation = 0
  private generation = 0
  private disposed = false
  private origin = 0
  private cursor: Array<{ time: number; step: number }> = []
  private output = ''
  private routedOutput: string | null = null
  async setOutput(id: string): Promise<void> {
    this.output = id
    if (this.context) { await setAudioContextOutputDevice(this.context, id); this.routedOutput = id }
  }
  private async ready(): Promise<AudioContext> {
    if (this.disposed) throw new Error('鼓机已关闭')
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.context.createGain()
      this.master.connect(this.context.destination)
    }
    const context = this.context
    if (this.routedOutput !== this.output) {
      await setAudioContextOutputDevice(context, this.output)
      this.routedOutput = this.output
    }
    if (context.state === 'suspended') await context.resume()
    if (this.disposed) throw new Error('鼓机已关闭')
    return context
  }
  async load(samples: DrumSample[], base: string): Promise<void> {
    const context = await this.ready()
    await Promise.all(samples.map(sample => {
      let pending = this.buffers.get(sample.midiNote)
      if (!pending) {
        pending = fetch(new URL(sample.file, base)).then(async response => {
          if (!response.ok) throw new Error(`无法载入音色：${sample.nameZh}`)
          return context.decodeAudioData(await response.arrayBuffer())
        }).catch(error => { this.buffers.delete(sample.midiNote); throw error })
        this.buffers.set(sample.midiNote, pending)
      }
      return pending
    }))
  }
  setVolume(volume: number): void {
    if (this.master && this.context) this.master.gain.setTargetAtTime(volume * 0.65, this.context.currentTime, 0.01)
  }
  private strike(note: number, buffer: AudioBuffer, time: number, velocity: number): void {
    if (!this.context || !this.master) return
    // Closing a hi-hat cuts all previously scheduled open-hat tails at this exact hit time.
    const choke = ({ 66: 49, 68: 57, 70: 55 } as Record<number, number>)[note]
    if (CLOSED_HATS.includes(note) || choke) for (const [source, midi] of this.voices) {
      if (OPEN_HATS.includes(midi) && CLOSED_HATS.includes(note) || midi === choke) { try { source.stop(time) } catch { /* ended */ } }
    }
    const source = this.context.createBufferSource(), gain = this.context.createGain()
    source.buffer = buffer
    gain.gain.value = velocity
    source.connect(gain); gain.connect(this.master)
    this.voices.set(source, note)
    source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect() }
    source.start(time)
  }
  async hit(sample: DrumSample, base: string, velocity: number, volume: number): Promise<void> {
    const ticket = this.generation
    await this.load([sample], base)
    const buffer = await this.buffers.get(sample.midiNote)!
    if (ticket !== this.generation || this.disposed) return
    this.setVolume(volume)
    this.strike(sample.midiNote, buffer, this.context!.currentTime, velocity)
  }
  elapsed(): number { return this.context ? Math.max(0, this.context.currentTime - this.origin) : 0 }
  async play(getDraft: () => DrumDraft, samples: DrumSample[], base: string, onStep: (step: number) => void, startStep = 0): Promise<boolean> {
    this.stop()
    if (!allowAudioAction()) return false
    this.audioSession = claimAudioSession('woodshed', '采样鼓机', () => this.stop())
    const ticket = this.generation
    await this.load(samples, base)
    if (ticket !== this.generation || this.disposed) return false
    const decoded = new Map<number, AudioBuffer>()
    await Promise.all(samples.map(async sample => decoded.set(sample.midiNote, await this.buffers.get(sample.midiNote)!)))
    if (ticket !== this.generation || this.disposed) return false
    const context = this.context!
    startStep = Math.max(0, Math.min(stepCount(getDraft()) - 1, startStep))
    this.origin = context.currentTime + 0.045 - drumStepTime(startStep, getDraft().bpm, getDraft().swing)
    let index = startStep, cycle = this.origin
    const fill = (): void => {
      const draft = getDraft(), length = stepCount(draft)
      this.setVolume(draft.volume)
      while (ticket === this.generation) {
        const at = cycle + drumStepTime(index, draft.bpm, draft.swing)
        if (at > context.currentTime + 0.08) break
        for (const track of draft.tracks) {
          const buffer = decoded.get(track.sample)
          if (buffer && track.hits[index]! > 0) this.strike(track.sample, buffer, at, track.hits[index]!)
        }
        this.cursor.push({ time: at, step: index })
        index++
        if (index >= length) { index = 0; cycle += length / 4 * 60 / draft.bpm }
      }
    }
    const animate = (): void => {
      if (ticket !== this.generation) return
      let latest: number | undefined
      while (this.cursor[0] && this.cursor[0].time <= context.currentTime) latest = this.cursor.shift()!.step
      if (latest !== undefined) onStep(latest)
      this.animation = requestAnimationFrame(animate)
    }
    fill(); this.timer = setInterval(fill, 20); animate()
    return true
  }
  stop(): void {
   if (this.audioSession !== undefined) releaseAudioSession('woodshed', this.audioSession)
   this.audioSession = undefined
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    cancelAnimationFrame(this.animation)
    this.cursor = []
    for (const source of this.voices.keys()) { try { source.stop() } catch { /* ended */ } }
    this.voices.clear()
  }
  destroy(): void { this.stop(); this.disposed = true; this.buffers.clear(); void this.context?.close() }
}
