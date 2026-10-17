import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { dbToGain, isStemVisible, stemPlaybackGain, type PracticeState, type SongDetail } from '@shared/domain.js'
import type { NativeAudioState } from '@shared/native-audio.js'
import { activeLoopRange } from '@shared/playback.js'
import type { AudioHostClient } from './audio-host.js'
import type { AppPaths } from './paths.js'
import type { BandBuddyDatabase } from './database.js'
import type { MediaService } from './media.js'
import type { ArsenalService } from './arsenal.js'
import { buildAtempoChain } from './export-filter.js'
import { runSignalsmithPitchShift } from './pitch-shift.js'
import { runProcess } from './process.js'

export class NativeAudioService {
  private song: SongDetail | null = null
  private practice: PracticeState | null = null
  private sampleRate = 48000
  private serial: Promise<unknown> = Promise.resolve()
  private lastState: NativeAudioState | null = null
  private preparation: AbortController | null = null
  private availableTracks = new Set<string>()
  constructor(private readonly paths: AppPaths, private readonly database: BandBuddyDatabase, private readonly media: MediaService,
    private readonly host: AudioHostClient, private readonly arsenal: ArsenalService, private readonly emit: (state: NativeAudioState) => void) {
    host.onEvent(event => {
      if (event.event === 'meter' && event.data.timeline) { this.lastState = event.data.timeline; this.emit({ ...event.data.timeline, sampleRate: this.sampleRate }) }
      else if (event.event === 'opened' && this.song && host.isTestSession() && event.data.sampleRate !== this.sampleRate) {
        const wasPlaying = this.lastState?.playing
        void this.enqueue(async () => { await this.loadNow(); if (wasPlaying) await host.timeline({ action: 'play' }) }).catch(error => this.emit({ positionMs: this.lastState?.positionMs ?? 0, playing: false, ended: false, generation: 0, countInRemaining: 0, underruns: 0, error: String(error) }))
      }
      else if (event.event === 'crashed' || event.event === 'error') this.emit({ positionMs: this.lastState?.positionMs ?? 0, playing: false, ended: false, generation: 0, countInRemaining: 0, underruns: 0, error: event.data.error })
    })
  }
  enabled(): boolean { return this.database.getSettings().recordingAudio.desktopEngine === 'native' }
  private enqueue<T>(action: () => Promise<T>): Promise<T> { const next = this.serial.catch(() => undefined).then(action); this.serial = next; return next }
  load(songId: string, practice: PracticeState): Promise<void> {
    this.preparation?.abort()
    return this.enqueue(async () => {
      const song = this.database.getSong(songId); if (!song) throw new Error('SONG_NOT_FOUND')
      this.song = song; this.practice = practice; await this.loadNow()
    })
  }
  refresh(songId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.song?.id !== songId) return
      const song = this.database.getSong(songId); if (!song) return
      this.song = song
      if (this.host.activeSampleRate() && this.host.isTestSession()) await this.loadNow(true)
    })
  }
  private async loadNow(attach = false): Promise<void> {
    if (!this.song || !this.practice) return
    if (this.host.activeSampleRate() && !this.host.isTestSession()) throw new Error('录音会话正在使用音频设备，请结束录音后再加载练习播放')
    const abort = new AbortController(); this.preparation = abort
    const settings = this.database.getSettings().recordingAudio
    this.sampleRate = this.host.activeSampleRate() ?? (settings.sampleRate || 48000)
    const root = path.join(this.paths.cacheRoot, 'native-playback'); await mkdir(root, { recursive: true })
    if (this.practice.tracks.some(t => (t.outputChannelPair ?? 1) !== 1)) throw new Error('原生引擎当前使用立体声输出；多通道分流请在设置中选择兼容引擎')
    const sources: Array<{ id: string; source: string; rate: number; pitch: number }> = []
    for (const file of this.database.getActiveStemFiles(this.song.id)) sources.push({ id: file.type, source: this.paths.resolveLibraryPath(this.database.getSettings().libraryRoot, file.relPath), rate: this.practice.playbackRate, pitch: file.type === 'drums' ? 0 : this.practice.pitchSemitones ?? 0 })
    for (const track of this.song.recordingTracks) {
      const take = this.song.recordingTakes.find(t => t.id === track.activeTakeId)
      if (!take || Math.abs(take.playbackRate - this.practice.playbackRate) > .0001 || (take.pitchSemitones ?? 0) !== (this.practice.pitchSemitones ?? 0)) continue
      const file = this.database.getRecordingTakeFile(take.id); if (!file) continue
      const source = await this.arsenal.render(this.paths.resolveLibraryPath(this.database.getSettings().libraryRoot, file.previewRelPath), track.effects, abort.signal, 0,
        { tempo: this.practice.metronomeBpm * this.practice.playbackRate, beatOffsetMs: this.practice.metronomeOffsetMs / this.practice.playbackRate })
      sources.push({ id: track.id, source, rate: 1, pitch: 0 })
    }
    this.availableTracks = new Set(sources.map(source => source.id))
    const tracks = []
    for (const source of sources) {
      abort.signal.throwIfAborted(); const info = await stat(source.source)
      const key = createHash('sha256').update(JSON.stringify([source, info.size, info.mtimeMs, this.sampleRate, 'native-v1'])).digest('hex')
      const target = path.join(root, `${key}.wav`)
      if (!existsSync(target)) {
        const temp = path.join(root, `${key}-${randomUUID()}.wav`), pitched = `${temp}.pitch.wav`
        try {
          const ffmpeg = await this.media.tool('ffmpeg'); if (!ffmpeg) throw new Error('FFMPEG_MISSING')
          const filters = buildAtempoChain(source.rate)
          const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', source.source, ...(filters.length ? ['-af', filters.join(',')] : []), '-vn', '-ar', String(this.sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', '-rf64', 'auto', temp], { signal: abort.signal })
          if (result.code) throw new Error(`NATIVE_DECODE_FAILED:${result.stderr}`)
          if (source.pitch) await runSignalsmithPitchShift(this.paths, temp, pitched, source.pitch, abort.signal)
          await rename(source.pitch ? pitched : temp, target)
        } finally { await Promise.all([temp, pitched].map(file => rm(file, { force: true }))) }
      }
      tracks.push({ id: source.id, path: target, gain: this.trackGain(source.id) })
    }
    if (!this.host.activeSampleRate()) await this.host.startTest({ outputOnly: true, backend: settings.backend === 'auto' ? process.platform === 'darwin' ? 'coreaudio' : 'wasapi-shared' : settings.backend, outputDeviceId: settings.outputDeviceId, sampleRate: this.sampleRate, bufferFrames: settings.bufferFrames })
    if (attach) await this.host.timeline({ action: 'attach', tracks, state: this.controls() })
    else await this.host.timeline({ action: 'load', graph: { ...this.controls(), sampleRate: this.sampleRate, playbackRate: this.practice.playbackRate, positionMs: this.practice.positionMs, tracks } })
  }
  private trackGain(id: string): number {
    if (!this.practice || !this.song) return 0
    const visible = this.practice.tracks.filter(t => this.song!.sourceFormat === 'existing-stems' || isStemVisible(t.stemType, this.practice!.guitarSplitEnabled, this.practice!.vocalSplitEnabled))
    const tracks = [...visible, ...this.song.recordingTracks.filter(track => this.availableTracks.has(track.id))]
    const solo = tracks.some(t => t.solo && !t.muted)
    const state = tracks.find(t => ('stemType' in t ? t.stemType : t.id) === id)
    return state && !state.muted && (!solo || state.solo) ? dbToGain(state.gainDb) * stemPlaybackGain(this.song.stems.find(stem => stem.type === id)) : 0
  }
  private controls(): Record<string, unknown> {
    const p = this.practice!, loop = activeLoopRange(p)
    return { tracks: [...p.tracks.map(t => t.stemType), ...(this.song?.recordingTracks.map(t => t.id) ?? [])].map(id => ({ id, gain: this.trackGain(id) })), masterGain: dbToGain(p.masterGainDb), bpm: p.metronomeBpm, beatOffsetMs: p.metronomeOffsetMs, metronome: p.metronomeEnabled, loopStartMs: loop?.startMs ?? 0, loopEndMs: loop?.endMs ?? 0, eq: p.eq }
  }
  update(practice: PracticeState): Promise<void> {
    return this.enqueue(async () => {
      if (!this.song || !this.practice) return
      const rebuild = practice.playbackRate !== this.practice.playbackRate || practice.pitchSemitones !== this.practice.pitchSemitones
      this.practice = practice
      if (!this.host.activeSampleRate() || !this.host.isTestSession()) return
      if (rebuild) { const playing = this.lastState?.playing; await this.host.timeline({ action: 'pause' }); this.practice = { ...practice, positionMs: this.lastState?.positionMs ?? practice.positionMs }; await this.loadNow(); if (playing) await this.host.timeline({ action: 'play' }) }
      else await this.host.timeline({ action: 'update', state: this.controls() })
    })
  }
  command(action: 'play' | 'pause' | 'seek' | 'unload', params: Record<string, unknown> = {}): Promise<void> {
    if (action === 'unload') this.preparation?.abort()
    return this.enqueue(async () => {
      if (!this.song) return
      if (action === 'play' && this.host.activeSampleRate() && !this.host.isTestSession()) throw new Error('录音进行中，请使用录音播放控制')
      if (!this.host.activeSampleRate() && action === 'play') await this.loadNow()
      if (this.host.activeSampleRate() && this.host.isTestSession()) {
        const state = await this.host.timeline({ action, ...params })
        if (state) { this.lastState = state; this.emit({ ...state, sampleRate: this.sampleRate }) }
        if (action === 'pause' && this.host.isPlaybackOnly()) {
          if (this.practice && state) this.practice = { ...this.practice, positionMs: state.positionMs }
          await this.host.stopTest()
        }
      } else if (action === 'seek' && this.practice) {
        this.practice = { ...this.practice, positionMs: Number(params.positionMs) }
        this.lastState = { positionMs: this.practice.positionMs, playing: false, ended: false, generation: (this.lastState?.generation ?? 0) + 1, countInRemaining: 0, underruns: 0, error: '' }
        this.emit({ ...this.lastState, sampleRate: this.sampleRate })
      }
      if (action === 'unload') { this.song = null; this.practice = null; this.host.clearTimeline(); if (this.host.isPlaybackOnly()) await this.host.stopTest() }
    })
  }
}
