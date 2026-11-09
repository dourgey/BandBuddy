import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { dbToGain, type PracticeState, type SongDetail } from '@shared/domain.js'
import { practiceMix } from '@shared/practice-mix.js'
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
import { RecordingPlaybackService, type RecordingPlaybackSource } from './recording-playback.js'

export class NativeAudioService {
  private song: SongDetail | null = null
  private practice: PracticeState | null = null
  private sampleRate = 48000
  private serial: Promise<unknown> = Promise.resolve()
  private pendingUpdate: { practice: PracticeState; promise: Promise<void> } | null = null
  private lastState: NativeAudioState | null = null
  private preparation: AbortController | null = null
  private preparingSources = false
  private loadedSourcesKey = ''
  private sourceRefresh: { key: string; promise: Promise<void> } | null = null
  private recordingNodes = new Map<string, { key: string; source: RecordingPlaybackSource }>()
  private retiredNodes: Array<{ revision: number; source: RecordingPlaybackSource }> = []
  constructor(private readonly paths: AppPaths, private readonly database: BandBuddyDatabase, private readonly media: MediaService,
    private readonly host: AudioHostClient, private readonly arsenal: ArsenalService, private readonly emit: (state: NativeAudioState) => void) {
    host.onEvent(event => {
      if (event.event === 'meter' && event.data.timeline) { this.lastState = event.data.timeline; this.releaseRetired(event.data.timeline.sourceRevision ?? -1); this.emit({ ...event.data.timeline, sampleRate: this.sampleRate }) }
      else if (event.event === 'opened' && this.song && host.isTestSession() && event.data.sampleRate !== this.sampleRate) {
        const wasPlaying = this.lastState?.playing
        void this.enqueue(async () => { await this.loadNow(); if (wasPlaying) await host.timeline({ action: 'play' }) }).catch(error => this.emit({ positionMs: this.lastState?.positionMs ?? 0, playing: false, ended: false, generation: 0, countInRemaining: 0, underruns: 0, error: String(error) }))
      }
      else if (event.event === 'crashed' || event.event === 'error') this.emit({ positionMs: this.lastState?.positionMs ?? 0, playing: false, ended: false, generation: 0, countInRemaining: 0, underruns: 0, error: event.data.error })
    })
  }
  enabled(): boolean { return this.database.getSettings().recordingAudio.desktopEngine === 'native' }
  private releaseRetired(revision = Infinity): void {
    const ready = this.retiredNodes.filter(node => node.revision <= revision)
    this.retiredNodes = this.retiredNodes.filter(node => node.revision > revision)
    void Promise.allSettled(ready.map(node => node.source.dispose()))
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    // Loads and transport commands form barriers: never coalesce across them.
    this.pendingUpdate = null
    const next = this.serial.catch(() => undefined).then(action); this.serial = next; return next
  }
  load(songId: string, practice: PracticeState): Promise<void> {
    this.preparation?.abort()
    return this.enqueue(async () => {
      const song = this.database.getSong(songId); if (!song) throw new Error('SONG_NOT_FOUND')
      this.song = song; this.practice = practice; await this.loadNow()
    })
  }
  refresh(songId: string): Promise<void> {
    if (this.song?.id !== songId) return Promise.resolve()
    const song = this.database.getSong(songId)
    if (!song) return Promise.resolve()
    this.song = song
    const key = this.sourceKey(song)
    // Pure mixer changes must not queue behind rendering, hashing or decoding.
    const mix = this.host.hasActiveTimeline() ? this.host.timeline({ action: 'update', state: this.controls() }).then(() => undefined) : Promise.resolve()
    void mix.catch(() => undefined) // It is also awaited below, possibly behind a render.
    if (key === this.loadedSourcesKey) return mix
    if (key === this.sourceRefresh?.key) return Promise.all([mix, this.sourceRefresh.promise]).then(() => undefined)
    const pending = { key, promise: Promise.resolve() }
    pending.promise = this.enqueue(async () => {
      if (this.song?.id !== songId) return
      if (this.sourceKey(this.song) !== key) return
      await mix
      if (this.host.activeSampleRate() && this.host.isTestSession()) await this.loadNow(true)
      else if (!this.host.activeSampleRate()) this.host.clearTimeline()
    }).finally(() => { if (this.sourceRefresh === pending) this.sourceRefresh = null })
    this.sourceRefresh = pending
    return pending.promise
  }
  private sourceKey(value: SongDetail): string {
    return JSON.stringify([value.id, value.stems.map(s => [s.type, s.mediaUrl]), value.recordingTracks.map(track => {
      const take = value.recordingTakes.find(t => t.id === track.activeTakeId)
      return [track.id, take?.id, take?.previewMediaUrl.replace(/([?&])effects=[^&]*/g, '$1'), take?.playbackRate, take?.pitchSemitones, track.effects?.enabled ? track.effects.chain : null]
    })])
  }
  private async loadNow(attach = false): Promise<void> {
    if (!this.song || !this.practice) return
    const song = this.song, practice = this.practice, sourceKey = this.sourceKey(song)
    if (this.host.activeSampleRate() && !this.host.isTestSession()) throw new Error('录音会话正在使用音频设备，请结束录音后再加载练习播放')
    const abort = new AbortController(); this.preparation = abort
    this.preparingSources = true
    const nextNodes = new Map<string, { key: string; source: RecordingPlaybackSource }>()
    let committed = false
    try {
      const settings = this.database.getSettings().recordingAudio
      this.sampleRate = this.host.activeSampleRate() ?? (settings.sampleRate || 48000)
      const root = path.join(this.paths.cacheRoot, 'native-playback'); await mkdir(root, { recursive: true })
      if (this.practice.tracks.some(t => (t.outputChannelPair ?? 1) !== 1)) throw new Error('原生引擎当前使用立体声输出；多通道分流请在设置中选择兼容引擎')
      const sources: Array<{ id: string; source: string; rate: number; pitch: number }> = []
      for (const file of this.database.getActiveStemFiles(song.id)) sources.push({ id: file.type, source: this.paths.resolveLibraryPath(this.database.getSettings().libraryRoot, file.relPath), rate: practice.playbackRate, pitch: file.type === 'drums' ? 0 : practice.pitchSemitones ?? 0 })
      const playback = new RecordingPlaybackService(this.paths, this.database, this.media, this.arsenal, this.host)
      const recordingTracks: Array<{ id: string; recording: Record<string, unknown>; gain: number }> = []
      for (const track of song.recordingTracks) {
        const take = song.recordingTakes.find(t => t.id === track.activeTakeId)
        if (!take) continue
        const file = this.database.getRecordingTakeFile(take.id); if (!file) continue
        const key = JSON.stringify([take.id, file.sourceRelPath, take.alignmentOffsetMs, this.sampleRate, practice.playbackRate, practice.pitchSemitones, practice.metronomeBpm, practice.metronomeOffsetMs, track.effects?.enabled ? track.effects.chain : null])
        const existing = this.recordingNodes.get(track.id)
        const node = existing?.key === key ? existing : { key, source: await playback.open(take, song.durationMs, practice, track.effects, this.sampleRate) }
        nextNodes.set(track.id, node)
        recordingTracks.push({ id: track.id, recording: node.source.config, gain: this.trackGain(track.id) })
      }
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
      abort.signal.throwIfAborted()
      // A newer source selection supersedes this render. Never attach an old
      // take/tone after the UI and mixer have already moved to the new one.
      if (!this.song || this.sourceKey(this.song) !== sourceKey) return
      if (!this.host.activeSampleRate()) await this.host.startTest({ outputOnly: true, backend: settings.backend === 'auto' ? process.platform === 'darwin' ? 'coreaudio' : 'wasapi-shared' : settings.backend, outputDeviceId: settings.outputDeviceId, sampleRate: this.sampleRate, bufferFrames: settings.bufferFrames })
      if (!this.song || this.sourceKey(this.song) !== sourceKey) return
      const finalTracks = [...tracks, ...recordingTracks].map(track => ({ ...track, gain: this.trackGain(track.id) }))
      const attached = attach && this.host.hasActiveTimeline()
      const state = attached ? await this.host.timeline({ action: 'attach', replace: true, tracks: finalTracks, state: this.controls() })
        : await this.host.timeline({ action: 'load', graph: { ...this.controls(), sampleRate: this.sampleRate, playbackRate: this.practice.playbackRate, positionMs: this.practice.positionMs, tracks: finalTracks } })
      this.loadedSourcesKey = sourceKey
      const retired = [...this.recordingNodes].filter(([id, node]) => nextNodes.get(id) !== node).map(([, node]) => node)
      this.recordingNodes = nextNodes; committed = true
      // A paused timeline may not consume the crossfade for minutes. Release
      // plugin workers only after the decoder acknowledges the new sources.
      this.retiredNodes.push(...retired.map(node => ({ source: node.source, revision: attached ? state?.requestedSourceRevision ?? Infinity : 0 })))
      this.releaseRetired(attached ? state?.sourceRevision ?? -1 : Infinity)
    } finally {
      if (!committed) await Promise.allSettled([...nextNodes].filter(([id, node]) => this.recordingNodes.get(id) !== node).map(([, node]) => node.source.dispose()))
      this.preparingSources = false; if (this.preparation === abort) this.preparation = null
    }
  }
  private trackGain(id: string): number {
    if (!this.practice || !this.song) return 0
    return practiceMix(this.song, this.practice).gains.get(id) ?? 0
  }
  private controls(): Record<string, unknown> {
    const p = this.practice!, loop = activeLoopRange(p)
    return {
      tracks: [...p.tracks.map(t => t.stemType), ...(this.song?.recordingTracks.map(t => t.id) ?? [])].map(id => ({ id, gain: this.trackGain(id) })),
      masterGain: dbToGain(p.masterGainDb),
      bpm: p.metronomeBpm,
      beatOffsetMs: p.metronomeOffsetMs,
      metronome: p.metronomeEnabled,
      metronomeGainDb: p.metronomeGainDb ?? 0,
      loopStartMs: loop?.startMs ?? 0,
      loopEndMs: loop?.endMs ?? 0,
      eq: p.eq
    }
  }
  update(practice: PracticeState): Promise<void> {
    if (this.preparingSources && this.practice && practice.playbackRate === this.practice.playbackRate && practice.pitchSemitones === this.practice.pitchSemitones) {
      // M/S, master and EQ remain live while the replacement source is built.
      this.practice = practice
      return this.host.hasActiveTimeline() ? this.host.timeline({ action: 'update', state: this.controls() }).then(() => undefined) : Promise.resolve()
    }
    if (this.pendingUpdate) { this.pendingUpdate.practice = practice; return this.pendingUpdate.promise }
    const pending = { practice, promise: Promise.resolve() }
    pending.promise = this.enqueue(async () => {
      if (this.pendingUpdate === pending) this.pendingUpdate = null
      const practice = pending.practice
      if (!this.song || !this.practice) return
      const previous = this.controls()
      const rebuild = practice.playbackRate !== this.practice.playbackRate || practice.pitchSemitones !== this.practice.pitchSemitones
      this.practice = practice
      if (!this.host.hasActiveTimeline()) return
      if (rebuild) { const playing = this.lastState?.playing; await this.host.timeline({ action: 'pause' }); this.practice = { ...practice, positionMs: this.lastState?.positionMs ?? practice.positionMs }; await this.loadNow(); if (playing) await this.host.timeline({ action: 'play' }) }
      else {
        const changes = Object.fromEntries(Object.entries(this.controls()).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key])))
        if (Object.keys(changes).length) await this.host.timeline({ action: 'update', state: changes })
      }
    })
    this.pendingUpdate = pending
    return pending.promise
  }
  command(action: 'play' | 'pause' | 'seek' | 'unload', params: Record<string, unknown> = {}): Promise<void> {
    if (action === 'unload') this.preparation?.abort()
    return this.enqueue(async () => {
      if (!this.song) return
      if (action === 'play' && this.host.activeSampleRate() && !this.host.isTestSession()) throw new Error('录音进行中，请使用录音播放控制')
      // A restored monitor may own the device without a playback timeline.
      // This happens when recording completion refreshed the song while closed.
      if (!this.host.hasActiveTimeline() && action === 'play') await this.loadNow()
      if (this.host.hasActiveTimeline()) {
        const state = await this.host.timeline({ action, ...params })
        if (state) { this.lastState = state; this.emit({ ...state, sampleRate: this.sampleRate }) }
        if (action === 'pause' && this.host.isPlaybackOnly()) {
          if (this.practice && state) this.practice = { ...this.practice, positionMs: state.positionMs }
          await this.host.stopTest()
          this.releaseRetired()
        }
      } else if (action === 'seek' && this.practice) {
        this.practice = { ...this.practice, positionMs: Number(params.positionMs) }
        this.lastState = { positionMs: this.practice.positionMs, playing: false, ended: false, generation: (this.lastState?.generation ?? 0) + 1, countInRemaining: 0, underruns: 0, error: '' }
        this.emit({ ...this.lastState, sampleRate: this.sampleRate })
      }
      if (action === 'unload') {
        this.song = null; this.practice = null; this.host.clearTimeline(); if (this.host.isPlaybackOnly()) await this.host.stopTest()
        await Promise.allSettled([...this.recordingNodes.values()].map(node => node.source.dispose())); this.recordingNodes.clear()
        this.releaseRetired()
      }
    })
  }
}
