import type { Sequencer } from 'spessasynth_lib'
import type { ScoreSynthesizer } from './synth.js'
import { scorePlaybackMidi, type ScoreData, type ScorePractice } from '@shared/scores.js'
import { claimAudioSession, isAudioSessionCurrent, releaseAudioSession } from '../audio-session.js'
import { allowAudioAction } from '../recording-session.js'
import { setAudioContextOutputDevice } from '../audio-engine.js'

export class ScoreAudio {
  private context: AudioContext | null = null
  private synth: ScoreSynthesizer | null = null
  private seq: Sequencer | null = null
  private initialization: Promise<void> | null = null
  private loading: Promise<void> | null = null
  private generation = 0
  private seeking = 0
  private session: number | undefined
  private base = 0
  private end = 0
  private pausedPosition = 0
  private data: ScoreData | null = null
  private channels: number[] = []
  private practice: ScorePractice | null = null
  private running = false
  private destroyed = false
  get playing(): boolean { return this.running && !this.seq?.paused }
  get position(): number {
    if (!this.running || !this.seq) return this.pausedPosition
    return Math.max(this.base, Math.min(this.end, this.base + this.seq.currentTime))
  }
  private async ready(): Promise<void> {
    if (this.synth) return
    if (this.initialization) return this.initialization
    this.initialization = (async () => {
      const [{ Sequencer }, { ScoreSynthesizer }, { default: workletUrl }] = await Promise.all([
        import('spessasynth_lib'), import('./synth.js'), import('spessasynth_lib/dist/spessasynth_processor.min.js?url')
      ])
      const font = await window.bandbuddy.scores.soundfont()
      if (this.destroyed) return
      const context = new AudioContext({ latencyHint: 'interactive' })
      this.context = context
      await context.audioWorklet.addModule(workletUrl)
      const synth = new ScoreSynthesizer(context)
      await synth.isReady
      await synth.soundBankManager.addSoundBank(new Uint8Array(font).buffer, 'BandBuddy General')
      if (this.destroyed) { synth.destroy(); await context.close(); return }
      const master = context.createGain(); master.gain.value = .65; master.connect(context.destination); synth.connect(master)
      this.synth = synth; this.seq = new Sequencer(synth, { skipToFirstNoteOn: false })
      this.seq.eventHandler.addEvent('songEnded', 'bandbuddy-score-end', () => {
        if (this.practice?.loop) return
        this.pausedPosition = this.end; this.pause(false)
      })
    })().catch(async error => { this.synth?.destroy(); this.synth = null; this.seq = null; await this.context?.close(); this.context = null; throw error })
      .finally(() => { this.initialization = null })
    return this.initialization
  }
  async play(data: ScoreData, practice: ScorePractice, label: string, output: string): Promise<boolean> {
    if (this.destroyed || !allowAudioAction()) return false
    this.pause(false)
    const ticket = this.generation
    this.session = claimAudioSession('scores', label, () => this.pause())
    const session = this.session
    try {
      await this.ready()
      if (ticket !== this.generation || !isAudioSessionCurrent(session) || !this.context || !this.synth || !this.seq) return false
      await setAudioContextOutputDevice(this.context, output)
      await this.context.resume()
      await this.loading?.catch(() => {})
      if (ticket !== this.generation || !isAudioSessionCurrent(session) || !allowAudioAction()) return false
      this.data = data; this.practice = practice
      this.base = practice.loop?.a ?? 0; this.end = Math.min(data.duration, practice.loop?.b ?? data.duration)
      const built = scorePlaybackMidi(data, this.base, this.end); this.channels = built.channels
      this.synth.reserveChannels(Math.ceil((Math.max(0, ...this.channels) + 1) / 16) * 16)
      const seq = this.seq
      const loading = new Promise<void>((resolve, reject) => {
        const key = `score-load-${ticket}`, timer = setTimeout(() => finish(new Error('MIDI 加载超时')), 30_000)
        const finish = (error?: Error): void => { clearTimeout(timer); seq.eventHandler.removeEvent('songChange', key); seq.eventHandler.removeEvent('midiError', key); error ? reject(error) : resolve() }
        seq.eventHandler.addEvent('songChange', key, () => finish())
        seq.eventHandler.addEvent('midiError', key, error => finish(error instanceof Error ? error : new Error(String(error))))
        seq.loadNewSongList([{ binary: built.bytes.buffer as ArrayBuffer, fileName: `${label}.mid` }])
      })
      this.loading = loading
      try { await loading } finally { if (this.loading === loading) this.loading = null }
      if (ticket !== this.generation || !isAudioSessionCurrent(session)) return false
      this.setMix(practice); seq.playbackRate = practice.rate; seq.loopCount = practice.loop ? Infinity : 0
      const position = practice.position >= this.end ? this.base : Math.max(this.base, practice.position)
      this.running = true; seq.play()
      await this.seek(position)
      return true
    } catch (error) { this.pause(); throw error }
  }
  setMix(practice: ScorePractice): void {
    this.practice = practice
    const solo = Object.values(practice.tracks).some(t => t.solo)
    this.data?.tracks.forEach((t, i) => {
      const state = practice.tracks[t.id], channel = this.synth?.midiChannels[this.channels[i]!]
      channel?.setSystemParameter('gain', state?.mute || solo && !state?.solo ? 0 : state?.volume ?? .8)
    })
    if (this.seq) this.seq.playbackRate = practice.rate
  }
  async seek(position: number): Promise<void> {
    this.pausedPosition = Math.max(this.base, Math.min(this.end, position))
    if (!this.seq || !this.running || !this.synth) return
    const seq = this.seq, ticket = this.generation, seekTicket = ++this.seeking
    const target = this.pausedPosition - this.base
    this.synth.stopAll(true)
    await new Promise<void>(resolve => {
      const key = `score-seek-${ticket}-${seekTicket}`
      const timer = setTimeout(() => { seq.eventHandler.removeEvent('timeChange', key); resolve() }, 1500)
      seq.eventHandler.addEvent('timeChange', key, event => { if (Math.abs(event.newTime - target) > .02) return; clearTimeout(timer); seq.eventHandler.removeEvent('timeChange', key); resolve() })
      seq.currentTime = target
    })
    if (ticket !== this.generation || seekTicket !== this.seeking || !this.running) return
    // Seek restores sustained notes whose Note On precedes the new position.
    this.data?.tracks.forEach((t, i) => { for (const n of t.notes) if (n.start < position - .005 && n.end > position) this.synth?.noteOn(this.channels[i]!, n.pitch, n.velocity) })
    if (this.practice) this.setMix(this.practice)
  }
  pause(capture = true): void {
    if (capture) this.pausedPosition = this.position
    this.generation++; this.running = false; this.seq?.pause(); this.synth?.stopAll(true)
    if (this.session !== undefined) releaseAudioSession('scores', this.session)
    this.session = undefined
  }
  async setOutput(output: string): Promise<void> { if (this.context) await setAudioContextOutputDevice(this.context, output) }
  destroy(): void { this.destroyed = true; this.pause(); this.synth?.destroy(); void this.context?.close(); this.synth = null; this.context = null }
}
