import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  dbToGain,
  type AudioBackend,
  type RecordingAudioSettings,
  type RecordingDeviceInfo,
  type RecordingMeter,
  type SongDetail,
  type TrackState
} from '@shared/domain.js'
import {
  buildRehearsalTimeline,
  createRehearsalRevisionSnapshot,
  rehearsalTimelinePosition,
  type RehearsalRecordingStartRequest,
  type RehearsalRecordingState,
  type RehearsalRecordingTake,
  type RehearsalRecordingTrackState,
  type RehearsalTimeline
} from '@shared/rehearsal.js'
import type {
  AudioHostClient,
  AudioHostEvent,
  AudioHostStartResult,
  AudioHostStopResult
} from './audio-host.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import { runProcess } from './process.js'
import { buildClockCorrectionFilters, calculateTakeAlignmentOffset, repairWaveHeader } from './recording.js'

interface ResolvedDeviceConfiguration {
  settings: RecordingAudioSettings
  backend: Exclude<AudioBackend, 'auto'>
  input: RecordingDeviceInfo
  output: RecordingDeviceInfo
  sampleRate: number
  bufferFrames: number
  splitDevices: boolean
  deviceAlignmentOffsetMs: number
}

interface RehearsalSessionMetadata {
  version: 1
  id: string
  rehearsalId: string
  recordingTrackId: string
  revisionId: string
  timelineFingerprint: string
  capturePath: string
  backingPath: string
  startPositionMs: number
  endPositionMs: number
  preRollBeats: 0 | 4 | 8
  preRollBpm: number
  device: ResolvedDeviceConfiguration
  host: AudioHostStartResult | null
  createdAt: string
}

interface ActiveRehearsalSession extends RehearsalSessionMetadata {
  sessionRoot: string
  finalizing: Promise<RehearsalRecordingTake | null> | null
  cancelled: boolean
}

const idleState = (): RehearsalRecordingState => ({
  target: 'rehearsal',
  phase: 'idle',
  sessionId: null,
  rehearsalId: null,
  recordingTrackId: null,
  revisionId: null,
  timelineFingerprint: null,
  timelinePositionMs: 0,
  preRollRemaining: 0,
  sampleRate: 0,
  bufferFrames: 0,
  latencyMs: 0,
  xruns: 0,
  splitDevices: false,
  message: '',
  error: null
})

const wait = async (milliseconds: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, milliseconds))

export class RehearsalRecordingService {
  private state = idleState()
  private active: ActiveRehearsalSession | null = null
  private preparingId: string | null = null
  private preparationAbort: AbortController | null = null
  private readonly cancelledPreparations = new Set<string>()
  private recovering = false

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly media: MediaService,
    private readonly host: AudioHostClient,
    private readonly logger: Logger,
    private readonly otherRecordingActive: () => boolean,
    private readonly emitState: (state: RehearsalRecordingState) => void,
    private readonly emitMeter: (meter: RecordingMeter) => void,
    private readonly changed: () => void
  ) {
    this.host.onEvent((event) => this.handleHostEvent(event))
  }

  getState(): RehearsalRecordingState { return this.state }
  isActive(): boolean { return this.recovering || !['idle', 'failed'].includes(this.state.phase) }

  async recoverInterruptedSessions(): Promise<void> {
    if (this.recovering || this.active) return
    this.recovering = true
    try {
      const settings = this.database.getSettings()
      for (const rehearsal of this.database.listRehearsals()) {
        const root = path.join(
          this.paths.rehearsalDirectory(settings.libraryRoot, rehearsal.id),
          '.recording-sessions'
        )
        let entries: string[] = []
        try { entries = await readdir(root) } catch { continue }
        for (const entry of entries) {
          const sessionRoot = path.join(root, entry)
          try {
            const metadata = JSON.parse(
              await readFile(path.join(sessionRoot, 'session.json'), 'utf8')
            ) as RehearsalSessionMetadata
            if (metadata.version !== 1
                || metadata.rehearsalId !== rehearsal.id
                || !existsSync(metadata.capturePath)) continue
            const track = this.database.getRehearsalRecordingTrack(metadata.recordingTrackId)
            const revision = this.database.getRehearsalRevision(metadata.revisionId)
            if (!track || track.rehearsalId !== rehearsal.id
                || !revision || revision.rehearsalId !== rehearsal.id) continue
            await repairWaveHeader(metadata.capturePath)
            const probe = await this.media.probe(metadata.capturePath)
            if (probe.durationMs <= 0) {
              await rm(sessionRoot, { recursive: true, force: true })
              continue
            }
            const session: ActiveRehearsalSession = {
              ...metadata,
              sessionRoot,
              finalizing: null,
              cancelled: false
            }
            this.active = session
            const recovered = await this.finalizeSession(session, {
              frames: Math.round(probe.durationMs * metadata.device.sampleRate / 1000),
              sampleRate: probe.sampleRate ?? metadata.device.sampleRate,
              channels: probe.channels ?? metadata.device.settings.inputChannels.length,
              xruns: 0,
              durationMs: probe.durationMs
            }, true)
            if (recovered) {
              this.logger.info('interrupted rehearsal recording recovered', {
                rehearsalId: rehearsal.id,
                takeId: recovered.id
              })
            }
          } catch (error) {
            this.active = null
            this.logger.warn('interrupted rehearsal recording could not be recovered', {
              sessionRoot,
              error: String(error)
            })
          }
        }
      }
    } finally {
      this.active = null
      this.recovering = false
    }
  }

  createTrack(rehearsalId: string): RehearsalRecordingTrackState {
    const result = this.database.createRehearsalRecordingTrack(rehearsalId)
    this.changed()
    return result
  }

  updateTrack(
    recordingTrackId: string,
    patch: Partial<Pick<RehearsalRecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): RehearsalRecordingTrackState {
    const result = this.database.updateRehearsalRecordingTrack(recordingTrackId, patch)
    this.changed()
    return result
  }

  selectTake(recordingTrackId: string, takeId: string | null): void {
    this.database.selectRehearsalRecordingTake(recordingTrackId, takeId)
    this.changed()
  }

  async updateTake(input: {
    takeId: string
    name?: string
    alignmentOffsetMs?: number
  }): Promise<RehearsalRecordingTake> {
    const take = this.database.getRehearsalRecordingTake(input.takeId)
    if (!take) throw new Error('REHEARSAL_RECORDING_TAKE_NOT_FOUND')
    let replacement: { preview: string; relative: string; old: string } | null = null
    if (input.alignmentOffsetMs !== undefined && input.alignmentOffsetMs !== take.alignmentOffsetMs) {
      const file = this.database.getRehearsalRecordingTakeFile(take.id)
      const revision = this.database.getRehearsalRevision(take.revisionId)
      if (!file || !revision) throw new Error('REHEARSAL_RECORDING_TAKE_NOT_FOUND')
      const settings = this.database.getSettings()
      const source = this.paths.resolveLibraryPath(settings.libraryRoot, file.sourceRelPath)
      const old = this.paths.resolveLibraryPath(settings.libraryRoot, file.previewRelPath)
      const preview = path.join(path.dirname(old), `preview-${randomUUID()}.flac`)
      await this.renderPreviewFile(
        source,
        preview,
        revision.snapshot.totalDurationMs,
        take.startPositionMs,
        input.alignmentOffsetMs
      )
      replacement = {
        preview,
        relative: this.paths.toLibraryRelative(settings.libraryRoot, preview),
        old
      }
    }
    try {
      const result = this.database.updateRehearsalRecordingTake(input.takeId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.alignmentOffsetMs !== undefined ? { alignmentOffsetMs: input.alignmentOffsetMs } : {}),
        ...(replacement ? { previewRelPath: replacement.relative } : {})
      })
      if (replacement) await rm(replacement.old, { force: true }).catch(() => undefined)
      this.changed()
      return result
    } catch (error) {
      if (replacement) await rm(replacement.preview, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async deleteTake(takeId: string): Promise<void> {
    const file = this.database.getRehearsalRecordingTakeFile(takeId)
    if (!file) return
    const settings = this.database.getSettings()
    const source = this.paths.resolveLibraryPath(settings.libraryRoot, file.sourceRelPath)
    const recordingsRoot = path.join(this.paths.rehearsalDirectory(settings.libraryRoot, file.rehearsalId), 'recordings')
    const takeRoot = path.dirname(source)
    const relative = path.relative(recordingsRoot, takeRoot)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('REHEARSAL_RECORDING_TAKE_PATH_INVALID')
    this.database.deleteRehearsalRecordingTake(takeId)
    await rm(takeRoot, { recursive: true, force: true })
    this.changed()
  }

  async start(request: RehearsalRecordingStartRequest): Promise<{ sessionId: string }> {
    if (this.isActive() || this.otherRecordingActive()) throw new Error('RECORDING_SESSION_BUSY')
    const rehearsal = this.database.getRehearsal(request.rehearsalId, false)
    if (!rehearsal) throw new Error('REHEARSAL_NOT_FOUND')
    const track = this.database.getRehearsalRecordingTrack(request.recordingTrackId)
    if (!track || track.rehearsalId !== rehearsal.id) throw new Error('REHEARSAL_RECORDING_TRACK_NOT_FOUND')
    const songs = await this.resolveSongs(rehearsal.items)
    const timeline = buildRehearsalTimeline(rehearsal.items, songs)
    if (!timeline.segments.length || timeline.totalDurationMs <= 0) throw new Error('REHEARSAL_EMPTY')
    if (timeline.unavailableItemIds.length) throw new Error('REHEARSAL_HAS_UNAVAILABLE_SONGS')
    const startPositionMs = Math.max(0, Math.min(request.positionMs, timeline.totalDurationMs))
    if (timeline.totalDurationMs - startPositionMs < 50) throw new Error('RECORDING_RANGE_TOO_SHORT')
    const timelinePosition = rehearsalTimelinePosition(timeline, startPositionMs)
    const preRollBeats = timelinePosition.segment?.kind === 'song'
      ? timelinePosition.segment.countInBeats
      : 0
    const preRollBpm = timelinePosition.segment?.kind === 'song'
      ? timelinePosition.segment.metronomeBpm * timelinePosition.segment.playbackRate
      : 120
    const snapshot = createRehearsalRevisionSnapshot(rehearsal, songs, timeline)
    const revision = this.database.getOrCreateRehearsalRevision(rehearsal.id, timeline.fingerprint, snapshot)

    const id = randomUUID()
    const settings = this.database.getSettings()
    const sessionRoot = path.join(this.paths.rehearsalDirectory(settings.libraryRoot, rehearsal.id), '.recording-sessions', id)
    mkdirSync(sessionRoot, { recursive: true })
    const capturePath = path.join(sessionRoot, 'capture.part.wav')
    const backingPath = path.join(sessionRoot, 'backing.wav')
    this.preparingId = id
    this.preparationAbort = new AbortController()
    this.patchState({
      phase: 'preparing',
      sessionId: id,
      rehearsalId: rehearsal.id,
      recordingTrackId: track.id,
      revisionId: revision.id,
      timelineFingerprint: timeline.fingerprint,
      timelinePositionMs: startPositionMs,
      preRollRemaining: 0,
      message: '正在准备整场排练伴奏',
      error: null
    })

    try {
      await this.ensureInputPermission()
      const device = await this.resolveDeviceConfiguration()
      await this.renderBacking(
        rehearsal.id,
        track.id,
        songs,
        timeline,
        startPositionMs,
        device.sampleRate,
        backingPath,
        this.preparationAbort.signal
      )
      if (this.cancelledPreparations.has(id)) throw new Error('RECORDING_CANCELLED')
      const metadata: RehearsalSessionMetadata = {
        version: 1,
        id,
        rehearsalId: rehearsal.id,
        recordingTrackId: track.id,
        revisionId: revision.id,
        timelineFingerprint: timeline.fingerprint,
        capturePath,
        backingPath,
        startPositionMs,
        endPositionMs: timeline.totalDurationMs,
        preRollBeats,
        preRollBpm,
        device,
        host: null,
        createdAt: new Date().toISOString()
      }
      await writeFile(path.join(sessionRoot, 'session.json'), JSON.stringify(metadata), 'utf8')
      const session: ActiveRehearsalSession = {
        ...metadata,
        sessionRoot,
        finalizing: null,
        cancelled: false
      }
      this.active = session
      this.preparingId = null
      this.preparationAbort = null
      const opened = await this.host.start({
        ...this.hostParameters(device),
        backingPath,
        capturePath,
        playbackRate: 1,
        startPositionMs,
        endPositionMs: timeline.totalDurationMs,
        metronomeEnabled: false,
        metronomeBpm: preRollBpm,
        metronomeOffsetMs: 0,
        countInBeats: preRollBeats
      })
      session.host = opened
      await writeFile(path.join(sessionRoot, 'session.json'), JSON.stringify(this.sessionMetadata(session)), 'utf8')
      this.patchState({
        phase: preRollBeats > 0 ? 'countIn' : 'armed',
        sampleRate: opened.sampleRate,
        bufferFrames: opened.bufferFrames,
        latencyMs: opened.latencyMs,
        splitDevices: opened.splitDevices,
        preRollRemaining: preRollBeats,
        message: preRollBeats > 0 ? `录音预备拍 ${preRollBeats}` : '整场录音已就绪'
      })
      return { sessionId: id }
    } catch (error) {
      const cancelled = this.cancelledPreparations.delete(id)
      if (this.preparingId === id) this.preparingId = null
      this.preparationAbort = null
      this.active = null
      await this.host.cancel().catch(() => undefined)
      await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined)
      if (cancelled) this.setState(idleState())
      else this.fail(error)
      throw error
    }
  }

  async pause(): Promise<void> {
    if (!this.active || !['armed', 'countIn', 'recording'].includes(this.state.phase)) return
    if (!await this.host.pause()) throw new Error('REHEARSAL_RECORDING_PAUSE_FAILED')
    this.patchState({ phase: 'paused', message: '录音已暂停，设备保持连接' })
  }

  async resume(): Promise<void> {
    if (!this.active || this.state.phase !== 'paused') return
    if (!await this.host.resume()) throw new Error('REHEARSAL_RECORDING_RESUME_FAILED')
    this.patchState({ phase: 'recording', message: '正在录音' })
  }

  async stop(): Promise<RehearsalRecordingTake | null> {
    if (this.state.phase === 'preparing') {
      await this.cancel()
      return null
    }
    const session = this.active
    if (!session) return null
    if (session.finalizing) return await session.finalizing
    this.patchState({ phase: 'stopping', message: '正在保留最后的尾音' })
    await wait(250)
    const result = await this.host.stop()
    if (!result || result.frames <= 0) {
      this.active = null
      await rm(session.sessionRoot, { recursive: true, force: true }).catch(() => undefined)
      this.setState(idleState())
      return null
    }
    return await this.beginFinalize(session, result, false)
  }

  async cancel(): Promise<void> {
    const session = this.active
    if (!session) {
      if (!this.preparingId) return
      const preparingId = this.preparingId
      this.cancelledPreparations.add(preparingId)
      this.preparationAbort?.abort()
      this.patchState({ phase: 'stopping', message: '正在取消录音准备' })
      while (this.preparingId === preparingId) await wait(20)
      return
    }
    if (session.finalizing) {
      await session.finalizing
      return
    }
    session.cancelled = true
    await this.host.cancel().catch(() => undefined)
    this.active = null
    await rm(session.sessionRoot, { recursive: true, force: true }).catch(() => undefined)
    this.setState(idleState())
  }

  async shutdown(save = true): Promise<void> {
    if (this.preparingId) await this.cancel()
    else if (this.active) {
      if (save) await this.stop().catch((error) => this.logger.error('rehearsal recording shutdown failed', error))
      else await this.cancel()
    }
  }

  private async resolveSongs(items: readonly { kind: string; songId?: string | null }[]): Promise<SongDetail[]> {
    const ids = [...new Set(items.flatMap((item) => item.kind === 'song' && item.songId ? [item.songId] : []))]
    return ids.flatMap((id) => {
      const song = this.database.getSong(id)
      return song ? [song] : []
    })
  }

  private async renderBacking(
    rehearsalId: string,
    targetTrackId: string,
    songs: SongDetail[],
    timeline: RehearsalTimeline,
    startPositionMs: number,
    sampleRate: number,
    output: string,
    signal: AbortSignal
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const sessionRoot = path.dirname(output)
    const byId = new Map(songs.map((song) => [song.id, song]))
    const segments = timeline.segments.filter((segment) => segment.endMs > startPositionMs)
    const files: string[] = []
    for (let index = 0; index < segments.length; index += 1) {
      if (signal.aborted) throw new Error('RECORDING_CANCELLED')
      const segment = segments[index]!
      const segmentOffsetMs = Math.max(0, startPositionMs - segment.startMs)
      const durationMs = segment.endMs - segment.startMs - segmentOffsetMs
      if (durationMs < 1) continue
      const target = path.join(sessionRoot, `segment-${String(index).padStart(4, '0')}.wav`)
      if (segment.kind === 'transition') {
        await this.renderSilenceOrClick(target, durationMs, sampleRate, null, segmentOffsetMs, signal)
      } else if (segment.kind === 'countIn') {
        await this.renderSilenceOrClick(
          target,
          durationMs,
          sampleRate,
          { bpm: segment.metronomeBpm * segment.playbackRate },
          segmentOffsetMs,
          signal
        )
      } else {
        const song = segment.songId ? byId.get(segment.songId) : null
        if (!song) throw new Error('REHEARSAL_HAS_UNAVAILABLE_SONGS')
        const sourceStartMs = segmentOffsetMs * segment.playbackRate
        await this.renderSongSegment(song, sourceStartMs, song.durationMs, sampleRate, target, signal)
      }
      files.push(target)
    }
    if (!files.length) throw new Error('RECORDING_RANGE_TOO_SHORT')
    const manifest = path.join(sessionRoot, 'segments.ffconcat')
    await writeFile(manifest, files.map((file) => `file '${escapeConcatPath(file)}'`).join('\n'), 'utf8')
    const base = path.join(sessionRoot, 'base.wav')
    const concat = await runProcess(ffmpeg, [
      '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', manifest,
      '-map_metadata', '-1', '-vn', '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', base
    ], { signal })
    if (concat.code !== 0) throw new Error(`REHEARSAL_BACKING_CONCAT_FAILED:${concat.stderr.slice(-800)}`)

    const rehearsal = this.database.getRehearsal(rehearsalId, false)
    if (!rehearsal) throw new Error('REHEARSAL_NOT_FOUND')
    const settings = this.database.getSettings()
    const activeTakes = rehearsal.recordingTracks.flatMap((track) => {
      const take = rehearsal.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
      if (!take || track.id === targetTrackId || take.timelineFingerprint !== timeline.fingerprint) return []
      const file = this.database.getRehearsalRecordingTakeFile(take.id)
      return file ? [{
        track,
        take,
        file: this.paths.resolveLibraryPath(settings.libraryRoot, file.previewRelPath)
      }] : []
    })
    const hasSolo = activeTakes.some(({ track }) => track.solo && !track.muted)
    const audibleTakes = activeTakes.filter(({ track }) => !track.muted && (!hasSolo || track.solo))
    const inputs = [
      ...(!hasSolo ? ['-i', base] : []),
      ...audibleTakes.flatMap(({ file }) => ['-i', file])
    ]
    if (inputs.length === 2 && !hasSolo && audibleTakes.length === 0) {
      await rename(base, output)
      return
    }
    if (!inputs.length) {
      await this.renderSilenceOrClick(
        output,
        timeline.totalDurationMs - startPositionMs,
        sampleRate,
        null,
        0,
        signal
      )
      return
    }
    const filters: string[] = []
    const labels: string[] = []
    let inputIndex = 0
    if (!hasSolo) {
      filters.push(`[0:a]asetpts=PTS-STARTPTS[base]`)
      labels.push('[base]')
      inputIndex = 1
    }
    audibleTakes.forEach(({ track }, index) => {
      const label = `rehearsal${index}`
      filters.push(
        `[${inputIndex + index}:a]atrim=start=${(startPositionMs / 1000).toFixed(6)},` +
        `asetpts=PTS-STARTPTS,volume=${dbToGain(track.gainDb).toFixed(8)}[${label}]`
      )
      labels.push(`[${label}]`)
    })
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.98:level=disabled[out]`)
    const mix = await runProcess(ffmpeg, [
      '-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]',
      '-t', ((timeline.totalDurationMs - startPositionMs) / 1000).toFixed(6),
      '-map_metadata', '-1', '-vn', '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', output
    ], { signal })
    if (mix.code !== 0) throw new Error(`REHEARSAL_BACKING_MIX_FAILED:${mix.stderr.slice(-800)}`)
  }

  private async renderSongSegment(
    song: SongDetail,
    startPositionMs: number,
    endPositionMs: number,
    sampleRate: number,
    output: string,
    signal: AbortSignal
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const files = this.database.getActiveStemFiles(song.id)
    const activeRecordings = song.recordingTracks.flatMap((track) => {
      const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
      return take && Math.abs(take.playbackRate - song.practice.playbackRate) <= 0.0001
        ? [{ track, take }]
        : []
    })
    const hasSolo = song.practice.tracks.some((track) => track.solo && !track.muted)
      || activeRecordings.some(({ track }) => track.solo && !track.muted)
    const audibleStems = song.practice.tracks
      .filter((track) => !track.muted && (!hasSolo || track.solo))
      .map((state) => ({ state, file: files.find((file) => file.type === state.stemType) }))
      .filter((entry): entry is { state: TrackState; file: NonNullable<typeof entry.file> } => Boolean(entry.file))
    const audibleRecordings = activeRecordings
      .filter(({ track }) => !track.muted && (!hasSolo || track.solo))
      .flatMap(({ track, take }) => {
        const file = this.database.getRecordingTakeFile(take.id)
        return file ? [{ track, take, file }] : []
      })
    const durationSeconds = Math.max(0.05, (endPositionMs - startPositionMs) / song.practice.playbackRate / 1000)
    const settings = this.database.getSettings()
    const inputs = [
      ...audibleStems.flatMap(({ file }) => ['-i', this.paths.resolveLibraryPath(settings.libraryRoot, file.relPath)]),
      ...audibleRecordings.flatMap(({ file }) => ['-i', this.paths.resolveLibraryPath(settings.libraryRoot, file.previewRelPath)]),
      ...(song.practice.metronomeEnabled
        ? ['-f', 'lavfi', '-i', clickSource(
          song.practice.metronomeBpm * song.practice.playbackRate,
          durationSeconds,
          sampleRate,
          (startPositionMs - song.practice.metronomeOffsetMs) / song.practice.playbackRate / 1000
        )]
        : [])
    ]
    if (!inputs.length) {
      await this.renderSilenceOrClick(output, durationSeconds * 1000, sampleRate, null, 0, signal)
      return
    }
    const filters: string[] = []
    const labels: string[] = []
    const tempo = atempoFilters(song.practice.playbackRate)
    audibleStems.forEach(({ state }, index) => {
      const label = `stem${index}`
      filters.push(
        `[${index}:a]atrim=start=${(startPositionMs / 1000).toFixed(6)}:end=${(endPositionMs / 1000).toFixed(6)},` +
        `asetpts=PTS-STARTPTS,aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${dbToGain(state.gainDb).toFixed(8)}${tempo ? `,${tempo}` : ''}[${label}]`
      )
      labels.push(`[${label}]`)
    })
    audibleRecordings.forEach(({ track }, index) => {
      const inputIndex = audibleStems.length + index
      const label = `take${index}`
      filters.push(
        `[${inputIndex}:a]atrim=start=${(startPositionMs / song.practice.playbackRate / 1000).toFixed(6)}:` +
        `end=${(endPositionMs / song.practice.playbackRate / 1000).toFixed(6)},asetpts=PTS-STARTPTS,` +
        `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${dbToGain(track.gainDb).toFixed(8)}[${label}]`
      )
      labels.push(`[${label}]`)
    })
    if (song.practice.metronomeEnabled) {
      const inputIndex = audibleStems.length + audibleRecordings.length
      filters.push(`[${inputIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[click]`)
      labels.push('[click]')
    }
    filters.push(
      `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,` +
      `volume=${dbToGain(song.practice.masterGainDb).toFixed(8)},alimiter=limit=0.98:level=disabled[out]`
    )
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]',
      '-t', durationSeconds.toFixed(6), '-map_metadata', '-1', '-vn',
      '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', output
    ], { signal })
    if (result.code !== 0) throw new Error(`REHEARSAL_SONG_RENDER_FAILED:${result.stderr.slice(-800)}`)
  }

  private async renderSilenceOrClick(
    output: string,
    durationMs: number,
    sampleRate: number,
    click: { bpm: number } | null,
    offsetMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const durationSeconds = Math.max(0.001, durationMs / 1000)
    const source = click
      ? clickSource(click.bpm, durationSeconds, sampleRate, offsetMs / 1000)
      : `anullsrc=r=${sampleRate}:cl=stereo:d=${durationSeconds.toFixed(6)}`
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', source, '-t', durationSeconds.toFixed(6),
      '-map_metadata', '-1', '-vn', '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', output
    ], { signal })
    if (result.code !== 0) throw new Error(`REHEARSAL_SILENCE_RENDER_FAILED:${result.stderr.slice(-800)}`)
  }

  private async beginFinalize(
    session: ActiveRehearsalSession,
    result: AudioHostStopResult,
    interrupted: boolean
  ): Promise<RehearsalRecordingTake | null> {
    if (session.finalizing) return await session.finalizing
    session.finalizing = this.finalizeSession(session, result, interrupted)
    return await session.finalizing
  }

  private async finalizeSession(
    session: ActiveRehearsalSession,
    result: AudioHostStopResult,
    interrupted: boolean
  ): Promise<RehearsalRecordingTake | null> {
    if (session.cancelled) return null
    this.patchState({ phase: 'finalizing', message: '正在生成整场录音与对齐预览' })
    try {
      if (!existsSync(session.capturePath) || result.frames <= 0) throw new Error('RECORDING_CAPTURE_EMPTY')
      const ffmpeg = this.media.tool('ffmpeg')
      if (!ffmpeg) throw new Error('FFMPEG_MISSING')
      const settings = this.database.getSettings()
      const revision = this.database.getRehearsalRevision(session.revisionId)
      if (!revision) throw new Error('REHEARSAL_REVISION_NOT_FOUND')
      const takeId = randomUUID()
      const rehearsalRoot = this.paths.rehearsalDirectory(settings.libraryRoot, session.rehearsalId)
      const preparedRoot = path.join(rehearsalRoot, '.recording-finalize', takeId)
      const finalRoot = path.join(rehearsalRoot, 'recordings', takeId)
      mkdirSync(preparedRoot, { recursive: true })
      const source = path.join(preparedRoot, 'source.flac')
      const sourceFilter = buildClockCorrectionFilters(
        result.sampleRate,
        session.device.splitDevices,
        result.clockCorrectionRatio ?? 1
      )
      const encoded = await runProcess(ffmpeg, [
        '-y', '-v', 'error', '-i', session.capturePath,
        ...(sourceFilter.length ? ['-af', sourceFilter.join(',')] : []),
        '-map_metadata', '-1', '-vn', '-c:a', 'flac', '-sample_fmt', 's32',
        '-bits_per_raw_sample', '24', source
      ])
      if (encoded.code !== 0) throw new Error(`RECORDING_SOURCE_ENCODE_FAILED:${encoded.stderr.slice(-800)}`)
      const probe = await this.media.probe(source)
      const alignmentOffsetMs = calculateTakeAlignmentOffset(
        session.device.deviceAlignmentOffsetMs,
        session.host?.latencyMs ?? 0,
        session.device.splitDevices,
        result.inputStartOutputFrames ?? 0,
        result.sampleRate
      )
      const preview = path.join(preparedRoot, 'preview.flac')
      await this.renderPreviewFile(
        source,
        preview,
        revision.snapshot.totalDurationMs,
        session.startPositionMs,
        alignmentOffsetMs
      )
      mkdirSync(path.dirname(finalRoot), { recursive: true })
      await rename(preparedRoot, finalRoot)
      const take = this.database.createRehearsalRecordingTake({
        id: takeId,
        rehearsalId: session.rehearsalId,
        recordingTrackId: session.recordingTrackId,
        revisionId: session.revisionId,
        timelineFingerprint: session.timelineFingerprint,
        name: this.database.nextRehearsalRecordingTakeName(session.recordingTrackId),
        sourceRelPath: this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, 'source.flac')),
        previewRelPath: this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, 'preview.flac')),
        durationMs: probe.durationMs || result.durationMs,
        startPositionMs: session.startPositionMs,
        endPositionMs: Math.min(
          revision.snapshot.totalDurationMs,
          session.startPositionMs + (probe.durationMs || result.durationMs)
        ),
        sampleRate: probe.sampleRate ?? result.sampleRate,
        channels: probe.channels ?? result.channels,
        alignmentOffsetMs,
        inputDeviceName: session.device.input.name,
        inputChannels: session.device.settings.inputChannels,
        deviceSnapshot: {
          backend: session.device.backend,
          inputDeviceId: session.device.input.id,
          inputDeviceName: session.device.input.name,
          outputDeviceId: session.device.output.id,
          outputDeviceName: session.device.output.name,
          inputChannels: session.device.settings.inputChannels,
          sampleRate: probe.sampleRate ?? result.sampleRate,
          bufferFrames: session.host?.bufferFrames ?? session.device.bufferFrames,
          latencyMs: session.host?.latencyMs ?? 0,
          splitDevices: session.device.splitDevices,
          softwareMonitoring: false
        },
        interrupted
      })
      await rm(session.sessionRoot, { recursive: true, force: true })
      this.active = null
      this.setState(idleState())
      this.changed()
      return take
    } catch (error) {
      this.active = null
      this.fail(error)
      throw error
    }
  }

  private async renderPreviewFile(
    source: string,
    output: string,
    totalDurationMs: number,
    startPositionMs: number,
    alignmentOffsetMs: number
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const delayMs = startPositionMs + alignmentOffsetMs
    const durationSeconds = Math.max(0.05, totalDurationMs / 1000)
    const filters = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (delayMs < 0) filters.push(`atrim=start=${(-delayMs / 1000).toFixed(6)}`, 'asetpts=PTS-STARTPTS')
    else if (delayMs > 0) filters.push(`adelay=${Math.round(delayMs)}:all=1`)
    filters.push(`apad=whole_dur=${durationSeconds.toFixed(6)}`)
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', '-i', source, '-af', filters.join(','), '-t', durationSeconds.toFixed(6),
      '-map_metadata', '-1', '-vn', '-c:a', 'flac', '-sample_fmt', 's32',
      '-bits_per_raw_sample', '24', '-ar', '44100', '-ac', '2', output
    ])
    if (result.code !== 0) throw new Error(`REHEARSAL_RECORDING_PREVIEW_FAILED:${result.stderr.slice(-800)}`)
  }

  private handleHostEvent(event: AudioHostEvent): void {
    const session = this.active
    if (!session) return
    if (event.event === 'crashed') {
      this.active = null
      this.fail(new Error(event.data.error))
      return
    }
    if (event.event === 'error') {
      if (event.data.capture && event.data.capture.frames > 0) {
        void this.beginFinalize(session, event.data.capture, true).catch((error) => this.fail(error))
      } else {
        this.active = null
        this.fail(new Error(event.data.error))
      }
      return
    }
    if (event.event === 'finished') {
      void this.beginFinalize(session, event.data, false).catch((error) => this.fail(error))
      return
    }
    this.emitMeter({
      peak: event.data.peak,
      rms: event.data.rms,
      clipped: event.data.clipped,
      sourcePositionMs: event.data.sourcePositionMs,
      recording: event.data.recording
    })
    if (this.state.phase === 'paused' || event.data.paused) return
    const phase = event.data.countInRemaining > 0 ? 'countIn' : event.data.recording ? 'recording' : 'armed'
    this.patchState({
      phase,
      timelinePositionMs: event.data.sourcePositionMs,
      preRollRemaining: event.data.countInRemaining,
      xruns: event.data.xruns,
      message: phase === 'countIn' ? `录音预备拍 ${event.data.countInRemaining}` : '正在录音'
    })
  }

  private async resolveDeviceConfiguration(): Promise<ResolvedDeviceConfiguration> {
    const settings = this.database.getSettings().recordingAudio
    const devices = await this.host.devices()
    const backend: Exclude<AudioBackend, 'auto'> = settings.backend === 'auto'
      ? (process.platform === 'darwin' ? 'coreaudio' : 'wasapi-shared')
      : settings.backend
    const candidates = devices.filter((device) => device.backend === backend)
    const input = settings.inputDeviceId
      ? candidates.find((device) => device.id === settings.inputDeviceId)
      : candidates.find((device) => device.defaultInput && device.inputChannels > 0)
        ?? candidates.find((device) => device.inputChannels > 0)
    const output = settings.outputDeviceId
      ? candidates.find((device) => device.id === settings.outputDeviceId)
      : candidates.find((device) => device.defaultOutput && device.outputChannels > 0)
        ?? candidates.find((device) => device.outputChannels > 0)
    if (!input) throw new Error(settings.inputDeviceId ? 'SELECTED_INPUT_DEVICE_MISSING' : 'NO_AUDIO_INPUT_DEVICE')
    if (!output) throw new Error(settings.outputDeviceId ? 'SELECTED_OUTPUT_DEVICE_MISSING' : 'NO_AUDIO_OUTPUT_DEVICE')
    const channels = settings.inputChannels
    if (channels.length !== (settings.inputChannelMode === 'mono' ? 1 : 2)) throw new Error('INPUT_CHANNEL_CONFIGURATION_INVALID')
    if (channels.some((channel) => channel < 0 || channel >= input.inputChannels)) throw new Error('INPUT_CHANNEL_UNAVAILABLE')
    if (channels.length === 2 && channels[1] !== channels[0]! + 1) throw new Error('STEREO_INPUT_CHANNELS_MUST_BE_ADJACENT')
    const commonRates = input.sampleRates.filter((rate) => output.sampleRates.includes(rate))
    const ratesUnknown = input.sampleRates.length === 0 || output.sampleRates.length === 0
    if (!ratesUnknown && commonRates.length === 0) throw new Error('NO_COMMON_SAMPLE_RATE')
    const sampleRate = settings.sampleRate
      || [output.preferredSampleRate, input.preferredSampleRate, 48_000, 44_100]
        .find((rate) => rate > 0 && (ratesUnknown || commonRates.includes(rate)))
      || commonRates[0]
    if (!sampleRate) throw new Error('NO_COMMON_SAMPLE_RATE')
    if (settings.sampleRate && !ratesUnknown && !commonRates.includes(settings.sampleRate)) {
      throw new Error('SELECTED_SAMPLE_RATE_UNAVAILABLE')
    }
    return {
      settings,
      backend,
      input,
      output,
      sampleRate,
      bufferFrames: settings.bufferFrames,
      splitDevices: input.id !== output.id,
      deviceAlignmentOffsetMs: settings.deviceAlignmentOffsets[
        `${backend}|${settings.inputDeviceId || 'default'}|${settings.outputDeviceId || 'default'}`
      ] ?? settings.alignmentOffsetMs
    }
  }

  private hostParameters(device: ResolvedDeviceConfiguration): Record<string, unknown> {
    return {
      backend: device.backend,
      inputDeviceId: device.input.id,
      outputDeviceId: device.output.id,
      inputChannels: device.settings.inputChannels,
      sampleRate: device.sampleRate,
      bufferFrames: device.bufferFrames,
      softwareMonitoring: false
    }
  }

  private async ensureInputPermission(): Promise<void> {
    if (process.platform !== 'darwin') return
    const { systemPreferences } = await import('electron')
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return
    if (status === 'denied' || status === 'restricted') throw new Error('MICROPHONE_PERMISSION_DENIED')
    if (!await systemPreferences.askForMediaAccess('microphone')) throw new Error('MICROPHONE_PERMISSION_DENIED')
  }

  private sessionMetadata(session: ActiveRehearsalSession): RehearsalSessionMetadata {
    return {
      version: 1,
      id: session.id,
      rehearsalId: session.rehearsalId,
      recordingTrackId: session.recordingTrackId,
      revisionId: session.revisionId,
      timelineFingerprint: session.timelineFingerprint,
      capturePath: session.capturePath,
      backingPath: session.backingPath,
      startPositionMs: session.startPositionMs,
      endPositionMs: session.endPositionMs,
      preRollBeats: session.preRollBeats,
      preRollBpm: session.preRollBpm,
      device: session.device,
      host: session.host,
      createdAt: session.createdAt
    }
  }

  private patchState(patch: Partial<RehearsalRecordingState>): void {
    this.setState({ ...this.state, ...patch })
  }

  private setState(state: RehearsalRecordingState): void {
    this.state = state
    this.emitState(state)
  }

  private fail(error: unknown): void {
    const message = String(error).replace(/^Error:\s*/, '')
    this.setState({ ...this.state, phase: 'failed', message: '排练录音已停止', error: message })
    this.logger.error('rehearsal recording failed', { error: message })
  }
}

function atempoFilters(rate: number): string {
  const factors: number[] = []
  let remaining = rate
  while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5 }
  while (remaining > 2) { factors.push(2); remaining /= 2 }
  if (Math.abs(remaining - 1) > 0.0001) factors.push(remaining)
  return factors.map((factor) => `atempo=${factor.toFixed(6)}`).join(',')
}

function clickSource(bpm: number, durationSeconds: number, sampleRate: number, offsetSeconds = 0): string {
  const period = 60 / Math.max(1, bpm)
  const phase = `mod(t+${offsetSeconds.toFixed(9)}\\,${period.toFixed(9)})`
  const expression = `0.18*sin(2*PI*1200*${phase})*lt(${phase}\\,0.012)`
  return `aevalsrc=exprs=${expression}:s=${sampleRate}:d=${durationSeconds.toFixed(6)}`
}

function escapeConcatPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/'/g, "'\\''")
}
