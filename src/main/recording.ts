import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  dbToGain,
  type AudioBackend,
  type RecordingAudioSettings,
  type RecordingDeviceInfo,
  type RecordingMeter,
  type RecordingStartRequest,
  type RecordingState,
  type RecordingTake,
  type RecordingTrackState,
  type TrackState
} from '@shared/domain.js'
import type { AudioHostClient, AudioHostEvent, AudioHostStartResult, AudioHostStopResult } from './audio-host.js'
import type { BandBuddyDatabase } from './database.js'
import type { Logger } from './logger.js'
import type { MediaService } from './media.js'
import type { AppPaths } from './paths.js'
import { runProcess } from './process.js'

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

interface SessionMetadata {
  version: 1 | 2
  id: string
  songId: string
  recordingTrackId: string | null
  capturePath: string
  backingPath: string
  startPositionMs: number
  endPositionMs: number
  playbackRate: number
  plannedEnd: boolean
  device: ResolvedDeviceConfiguration
  host: AudioHostStartResult | null
  createdAt: string
}

interface ActiveSession extends SessionMetadata {
  recordingTrackId: string
  sessionRoot: string
  finalizing: Promise<RecordingTake | null> | null
  cancelled: boolean
}

const idleState = (): RecordingState => ({
  target: 'song',
  phase: 'idle',
  sessionId: null,
  songId: null,
  recordingTrackId: null,
  sourcePositionMs: 0,
  countInRemaining: 0,
  sampleRate: 0,
  bufferFrames: 0,
  latencyMs: 0,
  xruns: 0,
  splitDevices: false,
  message: '',
  error: null
})

const wait = async (milliseconds: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, milliseconds))

export function resolveRecordingRange(
  songDurationMs: number,
  positionMs: number,
  practice: Pick<RecordingStartRequest['practice'], 'loopEnabled' | 'loopStartMs' | 'loopEndMs'>
): { startPositionMs: number; endPositionMs: number; plannedEnd: boolean } {
  const plannedEnd = practice.loopEnabled && practice.loopStartMs !== null && practice.loopEndMs !== null
    && practice.loopEndMs > practice.loopStartMs
  const startPositionMs = Math.max(0, Math.min(songDurationMs, plannedEnd ? practice.loopStartMs! : positionMs))
  const endPositionMs = Math.max(startPositionMs, Math.min(songDurationMs, plannedEnd ? practice.loopEndMs! : songDurationMs))
  return { startPositionMs, endPositionMs, plannedEnd }
}

export function buildClockCorrectionFilters(sampleRate: number, splitDevices: boolean, ratio = 1): string[] {
  if (!splitDevices) return []
  return [
    ...(Math.abs(ratio - 1) > 0.000001 ? [`asetrate=${(sampleRate * ratio).toFixed(6)}`] : []),
    `aresample=${sampleRate}:async=1000:first_pts=0`
  ]
}

export function calculateTakeAlignmentOffset(
  deviceOffsetMs: number,
  latencyMs: number,
  splitDevices: boolean,
  inputStartOutputFrames: number,
  sampleRate: number
): number {
  const splitCaptureStartMs = splitDevices ? inputStartOutputFrames * 1000 / Math.max(1, sampleRate) : 0
  return deviceOffsetMs - latencyMs + splitCaptureStartMs
}

export class RecordingService {
  private state = idleState()
  private active: ActiveSession | null = null
  private recovering = false
  private preparingId: string | null = null
  private preparationAbort: AbortController | null = null
  private readonly cancelledPreparations = new Set<string>()
  private startingTest = false

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly media: MediaService,
    private readonly host: AudioHostClient,
    private readonly logger: Logger,
    private readonly emitState: (state: RecordingState) => void,
    private readonly emitMeter: (meter: RecordingMeter) => void,
    private readonly changed: () => void
  ) {
    this.host.onEvent((event) => this.handleHostEvent(event))
  }

  getState(): RecordingState { return this.state }
  isActive(): boolean { return !['idle', 'failed'].includes(this.state.phase) }

  async recoverInterruptedSessions(): Promise<void> {
    if (this.recovering || this.active) return
    this.recovering = true
    try {
      const settings = this.database.getSettings()
      for (const song of this.database.listSongs('', 'all')) {
        const root = path.join(this.paths.songDirectory(settings.libraryRoot, song.id), '.recording-sessions')
        let entries: string[] = []
        try { entries = await readdir(root) } catch { continue }
        for (const entry of entries) {
          const sessionRoot = path.join(root, entry)
          try {
            const metadata = JSON.parse(await readFile(path.join(sessionRoot, 'session.json'), 'utf8')) as SessionMetadata
            if (![1, 2].includes(metadata.version) || metadata.songId !== song.id || !existsSync(metadata.capturePath)) continue
            const recordingTrack = (metadata.recordingTrackId ? this.database.getRecordingTrack(metadata.recordingTrackId) : null)
              ?? this.database.getRecordingTracks(song.id)[0]
              ?? this.database.createRecordingTrack(song.id)
            await repairWaveHeader(metadata.capturePath)
            const probe = await this.media.probe(metadata.capturePath)
            if (probe.durationMs <= 0) { await rm(sessionRoot, { recursive: true, force: true }); continue }
            const session: ActiveSession = {
              ...metadata,
              recordingTrackId: recordingTrack.id,
              sessionRoot,
              finalizing: null,
              cancelled: false
            }
            const recovered = await this.finalizeSession(session, {
              frames: Math.round(probe.durationMs * metadata.device.sampleRate / 1000),
              sampleRate: probe.sampleRate ?? metadata.device.sampleRate,
              channels: probe.channels ?? metadata.device.settings.inputChannels.length,
              xruns: 0,
              durationMs: probe.durationMs
            }, true)
            if (recovered) this.logger.info('interrupted recording recovered', { songId: song.id, takeId: recovered.id })
          } catch (error) {
            this.logger.warn('interrupted recording could not be recovered', { sessionRoot, error: String(error) })
          }
        }
      }
    } finally {
      this.recovering = false
    }
  }

  async devices(): Promise<RecordingDeviceInfo[]> {
    return await this.host.devices()
  }

  async startTest(): Promise<void> {
    if (this.isActive()) throw new Error('RECORDING_SESSION_BUSY')
    this.startingTest = true
    this.patchState({ phase: 'preparing', message: '正在打开音频输入', error: null })
    try {
      await this.ensureInputPermission()
      const device = await this.resolveDeviceConfiguration()
      if (!this.startingTest) return
      const opened = await this.host.startTest(this.hostParameters(device))
      if (!this.startingTest) return
      this.startingTest = false
      this.patchState({
        phase: 'testing', sampleRate: opened.sampleRate, bufferFrames: opened.bufferFrames,
        latencyMs: opened.latencyMs, splitDevices: opened.splitDevices, message: '输入测试中'
      })
    } catch (error) {
      const cancelled = !this.startingTest
      this.startingTest = false
      if (cancelled) {
        this.setState(idleState())
        return
      }
      this.fail(error)
      throw error
    }
  }

  async stopTest(): Promise<void> {
    const wasStarting = this.startingTest
    this.startingTest = false
    if (this.state.phase === 'testing' || wasStarting) await this.host.stopTest().catch(() => undefined)
    this.setState(idleState())
  }

  async start(request: RecordingStartRequest): Promise<{ sessionId: string }> {
    if (this.isActive()) throw new Error('RECORDING_SESSION_BUSY')
    const song = this.database.getSong(request.songId)
    if (!song || !song.stems.length) throw new Error('SONG_NOT_READY')
    if (request.practice.songId !== song.id) throw new Error('RECORDING_SONG_MISMATCH')
    const recordingTrack = this.database.getRecordingTrack(request.recordingTrackId)
    if (!recordingTrack || recordingTrack.songId !== song.id) throw new Error('RECORDING_TRACK_NOT_FOUND')
    const range = resolveRecordingRange(song.durationMs, request.positionMs, request.practice)
    const { startPositionMs, endPositionMs } = range
    if (endPositionMs - startPositionMs < 50) throw new Error('RECORDING_RANGE_TOO_SHORT')
    const id = randomUUID()
    this.preparingId = id
    this.preparationAbort = new AbortController()
    const settings = this.database.getSettings()
    const songRoot = this.paths.songDirectory(settings.libraryRoot, song.id)
    const sessionRoot = path.join(songRoot, '.recording-sessions', id)
    mkdirSync(sessionRoot, { recursive: true })
    const capturePath = path.join(sessionRoot, 'capture.part.wav')
    const backingPath = path.join(sessionRoot, 'backing.wav')
    this.patchState({
      phase: 'preparing', sessionId: id, songId: song.id, sourcePositionMs: startPositionMs,
      recordingTrackId: recordingTrack.id, countInRemaining: 0, message: '正在准备录音伴奏', error: null
    })

    try {
      await this.ensureInputPermission()
      const device = await this.resolveDeviceConfiguration()
      await this.renderBacking(request, startPositionMs, endPositionMs, device.sampleRate, backingPath, this.preparationAbort.signal)
      if (this.cancelledPreparations.has(id)) throw new Error('RECORDING_CANCELLED')
      const metadata: SessionMetadata = {
        version: 2,
        id,
        songId: song.id,
        recordingTrackId: recordingTrack.id,
        capturePath,
        backingPath,
        startPositionMs,
        endPositionMs,
        playbackRate: request.practice.playbackRate,
        plannedEnd: range.plannedEnd,
        device,
        host: null,
        createdAt: new Date().toISOString()
      }
      await writeFile(path.join(sessionRoot, 'session.json'), JSON.stringify(metadata), 'utf8')
      const session: ActiveSession = {
        ...metadata,
        recordingTrackId: recordingTrack.id,
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
        playbackRate: request.practice.playbackRate,
        startPositionMs,
        endPositionMs,
        metronomeEnabled: request.practice.metronomeEnabled,
        metronomeBpm: request.practice.metronomeBpm,
        metronomeOffsetMs: request.practice.metronomeOffsetMs,
        countInBeats: request.practice.countInBeats
      })
      if (session.cancelled) throw new Error('RECORDING_CANCELLED')
      session.host = opened
      await writeFile(path.join(sessionRoot, 'session.json'), JSON.stringify(sessionMetadata(session)), 'utf8')
      this.patchState({
        phase: request.practice.metronomeEnabled && request.practice.countInBeats > 0 ? 'countIn' : 'armed',
        sampleRate: opened.sampleRate,
        bufferFrames: opened.bufferFrames,
        latencyMs: opened.latencyMs,
        splitDevices: opened.splitDevices,
        message: opened.splitDevices ? '录音已就绪（输入与输出使用不同设备）' : '录音已就绪'
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

  async stop(): Promise<RecordingTake | null> {
    if (this.state.phase === 'preparing') {
      await this.cancel()
      return null
    }
    const session = this.active
    if (!session) {
      if (this.preparingId) await this.cancel()
      return null
    }
    if (session.finalizing) return await session.finalizing
    this.patchState({ phase: 'stopping', message: '正在保留最后的尾音' })
    await wait(250)
    const result = await this.host.stop()
    if (!result) return null
    if (result.frames <= 0) {
      if (this.active?.id === session.id) this.active = null
      await rm(session.sessionRoot, { recursive: true, force: true }).catch(() => undefined)
      this.setState(idleState())
      return null
    }
    return await this.beginFinalize(session, result, false)
  }

  async cancel(): Promise<void> {
    const session = this.active
    if (!session) {
      if (this.preparingId) {
        const preparingId = this.preparingId
        this.cancelledPreparations.add(preparingId)
        this.preparationAbort?.abort()
        this.patchState({ phase: 'stopping', message: '正在取消录音准备' })
        while (this.preparingId === preparingId) await wait(20)
      } else if (this.state.phase === 'testing') await this.stopTest()
      return
    }
    if (session.finalizing) {
      await session.finalizing
      return
    }
    session.cancelled = true
    if (this.state.phase === 'preparing') this.cancelledPreparations.add(session.id)
    await this.host.cancel().catch(() => undefined)
    this.active = null
    await rm(session.sessionRoot, { recursive: true, force: true }).catch(() => undefined)
    this.setState(idleState())
  }

  async updateTake(input: { takeId: string; name?: string; alignmentOffsetMs?: number }): Promise<RecordingTake> {
    const take = this.database.getRecordingTake(input.takeId)
    if (!take) throw new Error('RECORDING_TAKE_NOT_FOUND')
    let regenerated: Awaited<ReturnType<RecordingService['regeneratePreview']>> | null = null
    if (input.alignmentOffsetMs !== undefined && input.alignmentOffsetMs !== take.alignmentOffsetMs) {
      regenerated = await this.regeneratePreview({ ...take, alignmentOffsetMs: input.alignmentOffsetMs })
    }
    let updated: RecordingTake
    try {
      updated = this.database.updateRecordingTake(input.takeId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.alignmentOffsetMs !== undefined ? { alignmentOffsetMs: input.alignmentOffsetMs } : {}),
        ...(regenerated ? { previewRelPath: regenerated.previewRelPath, peaksRelPath: regenerated.peaksRelPath } : {})
      })
    } catch (error) {
      if (regenerated) await Promise.all(regenerated.newFiles.map((file) => rm(file, { force: true }).catch(() => undefined)))
      throw error
    }
    if (regenerated) await Promise.all(regenerated.oldFiles.map((file) => rm(file, { force: true }).catch(() => undefined)))
    this.changed()
    return updated
  }

  async deleteTake(takeId: string): Promise<void> {
    const file = this.database.getRecordingTakeFile(takeId)
    if (!file) return
    const settings = this.database.getSettings()
    const source = this.paths.resolveLibraryPath(settings.libraryRoot, file.sourceRelPath)
    const recordingsRoot = path.join(this.paths.songDirectory(settings.libraryRoot, file.songId), 'recordings')
    const takeRoot = path.dirname(source)
    const relative = path.relative(recordingsRoot, takeRoot)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('RECORDING_TAKE_PATH_INVALID')
    this.database.deleteRecordingTake(takeId)
    await rm(takeRoot, { recursive: true, force: true })
    this.changed()
  }

  selectTake(recordingTrackId: string, takeId: string | null): void {
    this.database.selectRecordingTake(recordingTrackId, takeId)
    this.changed()
  }

  createTrack(songId: string): RecordingTrackState {
    const result = this.database.createRecordingTrack(songId)
    this.changed()
    return result
  }

  updateTrack(
    recordingTrackId: string,
    patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): RecordingTrackState {
    const result = this.database.updateRecordingTrackState(recordingTrackId, patch)
    this.changed()
    return result
  }

  async shutdown(save = true): Promise<void> {
    if (this.startingTest || this.state.phase === 'testing') {
      await this.stopTest()
    } else if (this.preparingId) {
      await this.cancel()
    } else if (this.active) {
      if (save) await this.stop().catch((error) => this.logger.error('recording finalization during shutdown failed', error))
      else await this.cancel()
    }
    await this.host.shutdown()
  }

  async finishForTransition(): Promise<void> {
    if (this.startingTest || this.state.phase === 'testing') await this.stopTest()
    else if (this.preparingId || this.active) await this.stop()
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
      : candidates.find((device) => device.defaultInput && device.inputChannels > 0) ?? candidates.find((device) => device.inputChannels > 0)
    const output = settings.outputDeviceId
      ? candidates.find((device) => device.id === settings.outputDeviceId)
      : candidates.find((device) => device.defaultOutput && device.outputChannels > 0) ?? candidates.find((device) => device.outputChannels > 0)
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
      || [output.preferredSampleRate, input.preferredSampleRate, 48_000, 44_100].find((rate) => rate > 0 && (ratesUnknown || commonRates.includes(rate)))
      || commonRates[0]
    if (!sampleRate) throw new Error('NO_COMMON_SAMPLE_RATE')
    if (settings.sampleRate && !ratesUnknown && !commonRates.includes(settings.sampleRate)) throw new Error('SELECTED_SAMPLE_RATE_UNAVAILABLE')
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

  private async ensureInputPermission(): Promise<void> {
    if (process.platform !== 'darwin') return
    const { systemPreferences } = await import('electron')
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return
    if (status === 'denied' || status === 'restricted') throw new Error('MICROPHONE_PERMISSION_DENIED')
    if (!await systemPreferences.askForMediaAccess('microphone')) throw new Error('MICROPHONE_PERMISSION_DENIED')
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

  private async renderBacking(
    request: RecordingStartRequest,
    startPositionMs: number,
    endPositionMs: number,
    sampleRate: number,
    output: string,
    signal: AbortSignal
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const song = this.database.getSong(request.songId)
    if (!song) throw new Error('SONG_NOT_FOUND')
    const files = this.database.getActiveStemFiles(request.songId)
    const recordingTracks = this.database.getRecordingTracks(request.songId)
    const activeRecordings = recordingTracks.flatMap((track) => {
      const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
      return take ? [{ track, take }] : []
    })
    const hasSolo = request.practice.tracks.some((track) => track.solo && !track.muted)
      || activeRecordings.some(({ track }) => track.solo && !track.muted)
    const audibleStems = request.practice.tracks
      .filter((track) => !track.muted && (!hasSolo || track.solo))
      .map((state) => ({ state, file: files.find((file) => file.type === state.stemType) }))
      .filter((entry): entry is { state: TrackState; file: NonNullable<typeof entry.file> } => Boolean(entry.file))
    const settings = this.database.getSettings()
    const audibleRecordings = activeRecordings
      .filter(({ track, take }) => track.id !== request.recordingTrackId
        && !track.muted
        && (!hasSolo || track.solo)
        && Math.abs(take.playbackRate - request.practice.playbackRate) <= 0.0001)
      .flatMap(({ track, take }) => {
        const file = this.database.getRecordingTakeFile(take.id)
        return file ? [{ track, take, file }] : []
      })
    const durationSeconds = Math.max(0.05, (endPositionMs - startPositionMs) / request.practice.playbackRate / 1000)
    let args: string[]
    if (!audibleStems.length && !audibleRecordings.length) {
      args = ['-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo`, '-t', durationSeconds.toFixed(6)]
    } else {
      const inputs = [
        ...audibleStems.flatMap(({ file }) => ['-i', this.paths.resolveLibraryPath(settings.libraryRoot, file.relPath)]),
        ...audibleRecordings.flatMap(({ file }) => ['-i', this.paths.resolveLibraryPath(settings.libraryRoot, file.previewRelPath)])
      ]
      const filters: string[] = []
      const labels: string[] = []
      const tempo = atempoFilters(request.practice.playbackRate)
      audibleStems.forEach(({ state }, index) => {
        const label = `back${index}`
        filters.push(`[${index}:a]atrim=start=${(startPositionMs / 1000).toFixed(6)}:end=${(endPositionMs / 1000).toFixed(6)},asetpts=PTS-STARTPTS,aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${dbToGain(state.gainDb).toFixed(8)}${tempo ? `,${tempo}` : ''}[${label}]`)
        labels.push(`[${label}]`)
      })
      audibleRecordings.forEach(({ track }, recordingIndex) => {
        const inputIndex = audibleStems.length + recordingIndex
        const label = `recorded${recordingIndex}`
        filters.push(`[${inputIndex}:a]atrim=start=${(startPositionMs / request.practice.playbackRate / 1000).toFixed(6)}:end=${(endPositionMs / request.practice.playbackRate / 1000).toFixed(6)},asetpts=PTS-STARTPTS,aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${dbToGain(track.gainDb).toFixed(8)}[${label}]`)
        labels.push(`[${label}]`)
      })
      filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,volume=${dbToGain(request.practice.masterGainDb).toFixed(8)},alimiter=limit=0.98:level=disabled[out]`)
      args = [...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-t', durationSeconds.toFixed(6)]
    }
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', ...args, '-map_metadata', '-1', '-vn', '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', output
    ], { signal })
    if (result.code !== 0) throw new Error(`RECORDING_BACKING_FAILED:${result.stderr.slice(-800)}`)
  }

  private handleHostEvent(event: AudioHostEvent): void {
    const session = this.active
    if (event.event === 'crashed') {
      if (session) {
        this.active = null
        this.fail(new Error(event.data.error))
      } else if (this.state.phase === 'testing') this.fail(new Error(event.data.error))
      return
    }
    if (!session && this.state.phase === 'testing' && event.event === 'meter') {
      this.emitMeter({
        peak: event.data.peak,
        rms: event.data.rms,
        clipped: event.data.clipped,
        sourcePositionMs: event.data.sourcePositionMs,
        recording: event.data.recording
      })
      this.patchState({ xruns: event.data.xruns, message: event.data.xruns > 0 ? '检测到 xrun，请增大 buffer' : '输入测试中' })
      return
    }
    if (!session && this.state.phase === 'testing' && event.event === 'error') {
      this.fail(new Error(event.data.error))
      return
    }
    if (!session) return
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
    const phase = event.data.countInRemaining > 0 ? 'countIn' : event.data.recording ? 'recording' : 'armed'
    this.patchState({
      phase,
      sourcePositionMs: event.data.sourcePositionMs,
      countInRemaining: event.data.countInRemaining,
      xruns: event.data.xruns,
      message: phase === 'countIn' ? `预备拍 ${event.data.countInRemaining}` : '正在录音'
    })
  }

  private async beginFinalize(session: ActiveSession, result: AudioHostStopResult, interrupted: boolean): Promise<RecordingTake | null> {
    if (session.finalizing) return await session.finalizing
    session.finalizing = this.finalizeSession(session, result, interrupted)
    return await session.finalizing
  }

  private async finalizeSession(session: ActiveSession, result: AudioHostStopResult, interrupted: boolean): Promise<RecordingTake | null> {
    if (session.cancelled) return null
    if (this.active?.id === session.id) this.patchState({ phase: 'finalizing', message: '正在生成 FLAC、对齐预览和波形' })
    try {
      if (!existsSync(session.capturePath) || result.frames <= 0) throw new Error('RECORDING_CAPTURE_EMPTY')
      const ffmpeg = this.media.tool('ffmpeg')
      if (!ffmpeg) throw new Error('FFMPEG_MISSING')
      const settings = this.database.getSettings()
      const song = this.database.getSong(session.songId)
      if (!song) throw new Error('SONG_NOT_FOUND')
      const takeId = randomUUID()
      const songRoot = this.paths.songDirectory(settings.libraryRoot, song.id)
      const preparedRoot = path.join(songRoot, '.recording-finalize', takeId)
      const finalRoot = path.join(songRoot, 'recordings', takeId)
      mkdirSync(preparedRoot, { recursive: true })
      const sourcePart = path.join(preparedRoot, 'source.part.flac')
      const source = path.join(preparedRoot, 'source.flac')
      const correctionRatio = result.clockCorrectionRatio ?? 1
      const sourceFilter = buildClockCorrectionFilters(result.sampleRate, session.device.splitDevices, correctionRatio)
      const sourceResult = await runProcess(ffmpeg, [
        '-y', '-v', 'error', '-i', session.capturePath,
        ...(sourceFilter.length ? ['-af', sourceFilter.join(',')] : []),
        '-map_metadata', '-1', '-vn', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', sourcePart
      ])
      if (sourceResult.code !== 0) throw new Error(`RECORDING_SOURCE_ENCODE_FAILED:${sourceResult.stderr.slice(-800)}`)
      await rename(sourcePart, source)
      const probe = await this.media.probe(source)
      const alignmentOffsetMs = calculateTakeAlignmentOffset(
        session.device.deviceAlignmentOffsetMs,
        session.host?.latencyMs ?? 0,
        session.device.splitDevices,
        result.inputStartOutputFrames ?? 0,
        result.sampleRate
      )
      const durationMs = probe.durationMs || result.durationMs
      const endPositionMs = session.plannedEnd
        ? session.endPositionMs
        : Math.min(song.durationMs, session.startPositionMs + durationMs * session.playbackRate)
      const preview = path.join(preparedRoot, 'preview.flac')
      const peaks = path.join(preparedRoot, 'preview.peaks.json')
      await this.renderPreviewFile(source, preview, song.durationMs, session.startPositionMs, session.playbackRate, alignmentOffsetMs)
      await this.media.generatePeaks(preview, peaks, song.durationMs / session.playbackRate)
      mkdirSync(path.dirname(finalRoot), { recursive: true })
      await rename(preparedRoot, finalRoot)
      const take = this.database.createRecordingTake({
        id: takeId,
        songId: song.id,
        recordingTrackId: session.recordingTrackId,
        name: this.database.nextRecordingTakeName(session.recordingTrackId),
        sourceRelPath: this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, 'source.flac')),
        previewRelPath: this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, 'preview.flac')),
        peaksRelPath: this.paths.toLibraryRelative(settings.libraryRoot, path.join(finalRoot, 'preview.peaks.json')),
        durationMs,
        startPositionMs: session.startPositionMs,
        endPositionMs,
        playbackRate: session.playbackRate,
        sampleRate: probe.sampleRate ?? result.sampleRate,
        channels: probe.channels ?? result.channels,
        alignmentOffsetMs,
        backend: session.device.backend,
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
      if (this.active?.id === session.id) this.active = null
      this.setState(idleState())
      this.changed()
      return take
    } catch (error) {
      if (this.active?.id === session.id) this.active = null
      this.fail(error)
      throw error
    }
  }

  private async regeneratePreview(take: RecordingTake): Promise<{
    previewRelPath: string
    peaksRelPath: string
    newFiles: string[]
    oldFiles: string[]
  }> {
    const song = this.database.getSong(take.songId)
    const file = this.database.getRecordingTakeFile(take.id)
    if (!song || !file) throw new Error('RECORDING_TAKE_NOT_FOUND')
    const settings = this.database.getSettings()
    const source = this.paths.resolveLibraryPath(settings.libraryRoot, file.sourceRelPath)
    const oldPreview = this.paths.resolveLibraryPath(settings.libraryRoot, file.previewRelPath)
    const oldPeaks = file.peaksRelPath ? this.paths.resolveLibraryPath(settings.libraryRoot, file.peaksRelPath) : null
    const revision = randomUUID()
    const preview = path.join(path.dirname(oldPreview), `preview-${revision}.flac`)
    const peaks = path.join(path.dirname(oldPreview), `preview-${revision}.peaks.json`)
    const previewPart = `${preview}.part.flac`
    const peaksPart = `${peaks}.part.json`
    try {
      await this.renderPreviewFile(source, previewPart, song.durationMs, take.startPositionMs, take.playbackRate, take.alignmentOffsetMs)
      await this.media.generatePeaks(previewPart, peaksPart, song.durationMs / take.playbackRate)
      await rename(previewPart, preview)
      await rename(peaksPart, peaks)
    } catch (error) {
      await Promise.all([previewPart, peaksPart, preview, peaks].map((target) => rm(target, { force: true }).catch(() => undefined)))
      throw error
    }
    return {
      previewRelPath: this.paths.toLibraryRelative(settings.libraryRoot, preview),
      peaksRelPath: this.paths.toLibraryRelative(settings.libraryRoot, peaks),
      newFiles: [preview, peaks],
      oldFiles: [oldPreview, ...(oldPeaks ? [oldPeaks] : [])]
    }
  }

  private async renderPreviewFile(
    source: string,
    output: string,
    songDurationMs: number,
    startPositionMs: number,
    playbackRate: number,
    alignmentOffsetMs: number
  ): Promise<void> {
    const ffmpeg = this.media.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const delayMs = startPositionMs / playbackRate + alignmentOffsetMs
    const durationSeconds = Math.max(0.05, songDurationMs / playbackRate / 1000)
    const filters = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (delayMs < 0) filters.push(`atrim=start=${(-delayMs / 1000).toFixed(6)}`, 'asetpts=PTS-STARTPTS')
    else if (delayMs > 0) filters.push(`adelay=${Math.round(delayMs)}:all=1`)
    filters.push(`apad=whole_dur=${durationSeconds.toFixed(6)}`)
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', '-i', source, '-af', filters.join(','), '-t', durationSeconds.toFixed(6),
      '-map_metadata', '-1', '-vn', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', '44100', '-ac', '2', output
    ])
    if (result.code !== 0) throw new Error(`RECORDING_PREVIEW_FAILED:${result.stderr.slice(-800)}`)
  }

  private patchState(patch: Partial<RecordingState>): void {
    this.setState({ ...this.state, ...patch })
  }

  private setState(state: RecordingState): void {
    this.state = state
    this.emitState(state)
  }

  private fail(error: unknown): void {
    const message = String(error).replace(/^Error:\s*/, '')
    this.setState({ ...this.state, phase: 'failed', message: '录音已停止', error: message })
    this.logger.error('recording session failed', { error: message })
  }
}

function sessionMetadata(session: ActiveSession): SessionMetadata {
  return {
    version: 2,
    id: session.id,
    songId: session.songId,
    recordingTrackId: session.recordingTrackId,
    capturePath: session.capturePath,
    backingPath: session.backingPath,
    startPositionMs: session.startPositionMs,
    endPositionMs: session.endPositionMs,
    playbackRate: session.playbackRate,
    plannedEnd: session.plannedEnd,
    device: session.device,
    host: session.host,
    createdAt: session.createdAt
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

export async function repairWaveHeader(file: string): Promise<void> {
  const info = await stat(file)
  if (info.size < 44) throw new Error('INTERRUPTED_CAPTURE_TOO_SHORT')
  const handle = await open(file, 'r+')
  try {
    const riffSize = Math.min(0xffffffff, info.size - 8)
    const dataSize = Math.min(0xffffffff, info.size - 44)
    const value = Buffer.alloc(4)
    value.writeUInt32LE(riffSize, 0)
    await handle.write(value, 0, 4, 4)
    value.writeUInt32LE(dataSize, 0)
    await handle.write(value, 0, 4, 40)
  } finally {
    await handle.close()
  }
}
