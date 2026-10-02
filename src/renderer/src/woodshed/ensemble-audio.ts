import { claimAudioSession, releaseAudioSession } from '../audio-session.js'
import { allowAudioAction } from '../recording-session.js'
import { setAudioContextOutputDevice } from '../audio-engine.js'
import { measureBeats, type EnsembleEvent, type EnsembleScore } from './ensemble-material.js'

export interface EnsemblePlayback { bpm: number; demo: boolean; silentBars: number; countIn: number; clickEvery?: number; attack: number; release: number; cutoff: number; waveform: OscillatorType; decay?: number; sustain?: number; lfoRate?: number; lfoDepth?: number; lfoTarget?: 'pitch' | 'volume' | 'filter' }
export class EnsembleAudio {
 private audioSession: number | undefined
 private context: AudioContext | null = null
 private master: GainNode | null = null
 private sources = new Set<AudioScheduledSourceNode>()
 private timer: ReturnType<typeof setInterval> | null = null
 private generation = 0
 private disposed = false
 private origin = 0
 private unitSeconds = 1
 private options: EnsemblePlayback | null = null
 private score: EnsembleScore | null = null
 private countInBeats = 0
 private noise: AudioBuffer | null = null
 get position(): number {
  if (!this.context || !this.options) return -1
  const stamp = this.context.getOutputTimestamp?.()
  const now = stamp?.contextTime || Math.max(0, this.context.currentTime - (this.context.outputLatency || 0))
  return (now - this.origin) / this.unitSeconds - this.countInBeats
 }
 get silent(): boolean {
  if (!this.score || !this.options || this.position < 0) return false
  return this.options.silentBars > 0 && Math.floor(this.position / measureBeats(this.score.meter)) % (this.options.silentBars + 1) !== 0
 }
 async start(score: EnsembleScore, options: EnsemblePlayback, output: string): Promise<boolean> {
  this.stop()
  if (this.disposed || !allowAudioAction()) return false
  this.audioSession = claimAudioSession('woodshed', '合奏练习', () => this.stop())
  const ticket = this.generation
  if (!this.context) { this.context = new AudioContext({ latencyHint: 'interactive' }); this.master = this.context.createGain(); this.master.gain.value = .35; this.master.connect(this.context.destination) }
  const context = this.context
  await setAudioContextOutputDevice(context, output)
  if (ticket !== this.generation || this.disposed) return false
  await context.resume()
  if (ticket !== this.generation || this.disposed) return false
  this.score = score; this.options = options
  this.unitSeconds = 60 / options.bpm / score.beatUnit
  const barLength = measureBeats(score.meter), length = barLength * score.bars
  this.countInBeats = options.countIn * barLength
  this.origin = this.context.currentTime + .07
  let nextClick = 0, cycle = 0, index = 0
  const events = [...score.events].sort((a, b) => a.beat - b.beat)
  const at = (beat: number): number => this.origin + beat * this.unitSeconds
  const isSilent = (beat: number): boolean => beat >= this.countInBeats && options.silentBars > 0 && Math.floor((beat - this.countInBeats) / barLength) % (options.silentBars + 1) !== 0
  const tick = (): void => {
   const context = this.context!
   const horizon = context.currentTime + .12
   // Skip expired events after suspension rather than replaying a backlog.
   const elapsed = Math.max(0, (context.currentTime - this.origin) / this.unitSeconds)
   if (at(nextClick) < context.currentTime - .1) nextClick = Math.ceil(elapsed / score.beatUnit) * score.beatUnit
   if (events.length && at(this.countInBeats + cycle * length + events[index]!.beat) < context.currentTime - .1) {
    const musicBeat = Math.max(0, elapsed - this.countInBeats)
    cycle = Math.floor(musicBeat / length)
    index = events.findIndex(e => e.beat >= musicBeat % length)
    if (index < 0) { cycle++; index = 0 }
   }
   while (at(nextClick) < horizon) {
    const clickIndex = Math.round((nextClick - this.countInBeats) / score.beatUnit)
    if (!isSilent(nextClick) && (nextClick < this.countInBeats || clickIndex % (options.clickEvery ?? 1) === 0)) this.tone(nextClick % barLength < .001 ? 90 : 83, at(nextClick), .035, .12, 'sine')
    nextClick += score.beatUnit
   }
   if (options.demo && events.length) while (at(this.countInBeats + cycle * length + events[index]!.beat) < horizon) {
    const e = events[index]!, beat = this.countInBeats + cycle * length + e.beat
    if (!isSilent(beat)) this.playEvent(e, at(beat), options)
    if (++index === events.length) { index = 0; cycle++ }
   }
  }
  tick(); this.timer = setInterval(tick, 25)
  return true
 }
 private track(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  this.sources.add(source)
  source.onended = () => { this.sources.delete(source); source.disconnect(); nodes.forEach(n => n.disconnect()) }
 }
 private tone(midi: number, time: number, duration: number, velocity: number, waveform: OscillatorType, attack = .008, release = .06, cutoff = 8000, synth?: EnsemblePlayback): void {
  const c = this.context!, source = c.createOscillator(), gain = c.createGain(), filter = c.createBiquadFilter()
  source.type = waveform; source.frequency.value = 440 * 2 ** ((midi - 69) / 12)
  filter.type = 'lowpass'; filter.frequency.value = cutoff
  const rise = Math.min(attack, duration * .8), end = time + duration
  const peak = velocity * .4, sustain = Math.max(.0001, peak * (synth?.sustain ?? 1))
  gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(peak, time + Math.max(.002, rise))
  gain.gain.linearRampToValueAtTime(sustain, Math.min(end, time + rise + (synth?.decay ?? .01)))
  gain.gain.setValueAtTime(sustain, end); gain.gain.exponentialRampToValueAtTime(.0001, end + release)
  source.connect(filter); filter.connect(gain); gain.connect(this.master!)
  this.track(source, [filter, gain]); source.start(time); source.stop(end + release + .02)
  if (synth?.lfoDepth && synth.lfoRate) {
   const lfo = c.createOscillator(), amount = c.createGain()
   lfo.frequency.value = synth.lfoRate
   const target = synth.lfoTarget ?? 'pitch'
   amount.gain.value = synth.lfoDepth * (target === 'pitch' ? 100 : target === 'filter' ? cutoff * .8 : sustain * .5)
   lfo.connect(amount); amount.connect(target === 'pitch' ? source.detune : target === 'filter' ? filter.frequency : gain.gain)
   this.track(lfo, [amount]); lfo.start(time); lfo.stop(end + release + .02)
  }
 }
 private playEvent(e: EnsembleEvent, at: number, options: EnsemblePlayback): void {
  if (!e.drum) { e.notes.forEach(n => this.tone(n, at, e.duration * this.unitSeconds * .9, e.velocity / Math.sqrt(Math.max(1, e.notes.length)), options.waveform, options.attack, options.release, options.cutoff, options)); return }
  if (e.drum === 'kick' || e.drum === 'tom') { this.tone(e.drum === 'kick' ? 30 : 47, at, .07, e.velocity, 'sine', .003, .1); return }
  const c = this.context!
  if (!this.noise) { this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const data = this.noise.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1 }
  const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain()
  source.buffer = this.noise; filter.type = 'highpass'; filter.frequency.value = e.drum === 'snare' ? 1200 : 6000
  const duration = e.drum === 'openHat' || e.drum === 'crash' ? .32 : .06
  gain.gain.setValueAtTime(e.velocity * .35, at); gain.gain.exponentialRampToValueAtTime(.0001, at + duration)
  source.connect(filter); filter.connect(gain); gain.connect(this.master!)
  this.track(source, [filter, gain]); source.start(at); source.stop(at + duration + .01)
 }
 stop(): void {
  if (this.audioSession !== undefined) releaseAudioSession('woodshed', this.audioSession)
  this.audioSession = undefined
  this.generation++
  if (this.timer) clearInterval(this.timer)
  this.timer = null; this.options = null
  for (const s of this.sources) { try { s.stop() } catch { /* already ended */ } s.disconnect() }
  this.sources.clear()
 }
 destroy(): void { this.disposed = true; this.stop(); void this.context?.close(); this.context = null }
}
