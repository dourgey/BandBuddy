import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PracticeState, RecordingTake } from '@shared/domain.js'
import type { TrackEffects } from '@shared/arsenal.js'
import { recordingPitch, recordingPlaybackRate } from '@shared/practice-mix.js'
import type { AppPaths } from './paths.js'
import type { BandBuddyDatabase } from './database.js'
import type { MediaService } from './media.js'
import type { ArsenalService } from './arsenal.js'
import type { AudioHostClient } from './audio-host.js'
import { runProcess, spawnSafe } from './process.js'
import { mediaResponseHeaders, parseByteRange } from './media-range.js'

export interface RecordingPlaybackSource {
  config: Record<string, unknown>
  dispose(): Promise<void>
}

/** File-backed streaming DSP. New takes never enter FFmpeg on this path. */
export class RecordingPlaybackService {
  private decoding = new Map<string, Promise<string>>()
  private readers = new Map<string, Set<{ abort: AbortController; done: Promise<void> }>>()
  private deleting = new Set<string>()
  constructor(private paths: AppPaths, private db: BandBuddyDatabase, private media: MediaService,
    private arsenal: ArsenalService, private host: AudioHostClient) {}

  async withoutReaders<T>(takeId: string, action: () => Promise<T>): Promise<T> {
    if (this.deleting.has(takeId)) throw new Error('RECORDING_TAKE_DELETING')
    this.deleting.add(takeId)
    try {
      const readers = [...(this.readers.get(takeId) ?? [])]
      for (const reader of readers) reader.abort.abort()
      await Promise.all(readers.map(reader => reader.done))
      return await action()
    } finally { this.deleting.delete(takeId) }
  }

  private async takeStream(take: RecordingTake, durationMs: number, practice: PracticeState, effects: TrackEffects | null | undefined,
    sampleRate: number, options: Record<string, unknown>, signal: AbortSignal): Promise<ReturnType<RecordingPlaybackService['stream']>> {
    if (this.deleting.has(take.id)) throw new Error('RECORDING_TAKE_DELETING')
    const abort = new AbortController()
    let resolve!: () => void
    const entry = { abort, done: new Promise<void>(done => { resolve = done }) }
    const readers = this.readers.get(take.id) ?? new Set()
    this.readers.set(take.id, readers); readers.add(entry)
    const finish = (): void => { readers.delete(entry); if (!readers.size) this.readers.delete(take.id); resolve() }
    let source: RecordingPlaybackSource | undefined
    try {
      source = await this.open(take, durationMs, practice, effects, sampleRate)
      const stream = this.stream(source, options, AbortSignal.any([signal, abort.signal]))
      void stream.done.finally(finish).catch(() => undefined)
      return stream
    } catch (error) { try { await source?.dispose() } finally { finish() }; throw error }
  }

  private async source(take: RecordingTake): Promise<string> {
    const file = this.db.getRecordingTakeFile(take.id)
    if (!file) throw new Error('RECORDING_TAKE_NOT_FOUND')
    const root = this.db.getSettings().libraryRoot
    const original = take.deviceSnapshot.originalCaptureRelPath
    if (original && (take.deviceSnapshot.compactRecording || !take.deviceSnapshot.splitDevices)) {
      const raw = this.paths.resolveLibraryPath(root, original)
      if (existsSync(raw)) return raw
    }
    const source = this.paths.resolveLibraryPath(root, file.sourceRelPath)
    if (path.extname(source).toLowerCase() === '.wav') return source
    // Legacy libraries may only have FLAC. Decode the compact take once, never
    // the padded preview or an effect render; subsequent reads reuse it.
    const info = await stat(source), key = createHash('sha256').update(JSON.stringify([source, info.size, info.mtimeMs])).digest('hex')
    const directory = path.join(this.paths.cacheRoot, 'recording-pcm'), target = path.join(directory, `${key}.wav`)
    if (existsSync(target)) return target
    let task = this.decoding.get(key)
    if (!task) {
      task = (async () => {
        await mkdir(directory, { recursive: true })
        const ffmpeg = await this.media.tool('ffmpeg'); if (!ffmpeg) throw new Error('FFMPEG_MISSING')
        const temp = path.join(directory, `${key}-${randomUUID()}.wav`)
        try {
          const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', source, '-ac', '2', '-c:a', 'pcm_f32le', '-rf64', 'auto', temp])
          if (result.code) throw new Error(`RECORDING_DECODE_FAILED:${result.stderr}`)
          await rename(temp, target); return target
        } finally { await rm(temp, { force: true }) }
      })().finally(() => this.decoding.delete(key))
      this.decoding.set(key, task)
    }
    return task
  }

  async open(take: RecordingTake, durationMs: number, practice: PracticeState, effects: TrackEffects | null | undefined,
    sampleRate: number): Promise<RecordingPlaybackSource> {
    const [source, prepared] = await Promise.all([this.source(take), effects?.enabled ? this.arsenal.prepare(effects.chain) : undefined])
    const worker = prepared?.pluginGraph ? await this.host.plugins.prepare(prepared, sampleRate) : null
    return {
      config: { path: source, sampleRate, durationMs: durationMs / practice.playbackRate,
        rate: recordingPlaybackRate(take, practice), pitch: recordingPitch(take, practice),
        offsetMs: take.startPositionMs / take.playbackRate + take.alignmentOffsetMs,
        clockRatio: take.deviceSnapshot.compactRecording ? take.deviceSnapshot.clockCorrectionRatio ?? 1 : 1,
        tempo: practice.metronomeBpm * practice.playbackRate, beatOffsetMs: practice.metronomeOffsetMs / practice.playbackRate,
        ...(worker ? { pluginMapping: worker.mapping } : prepared ? { prepared } : {}) },
      dispose: async () => { await worker?.stop() }
    }
  }

  private stream(source: RecordingPlaybackSource, options: Record<string, unknown>, signal: AbortSignal): { audio: Readable; done: Promise<void>; abort(): void } {
    const operation = new AbortController()
    signal.throwIfAborted()
    const child = spawnSafe(this.paths.audioHostExecutable(), ['--recording-stream'], { signal: operation.signal })
    const abort = (): void => {
      operation.abort()
      // Chromium may stop reading once its media buffer is full. Closing the
      // pipe is necessary for ChildProcess.close to arrive after termination.
      child.stdout.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    let diagnostic = ''
    child.stderr.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-2000) })
    child.stdin.on('error', error => child.stdout.destroy(error))
    const done = new Promise<void>((resolve, reject) => {
      // Abort emits error before close; wait for close to release Windows file
      // handles before a take deletion is allowed to continue.
      let processError: Error | undefined
      child.once('error', error => { processError = error })
      child.once('close', code => {
        signal.removeEventListener('abort', abort)
        void source.dispose().then(() => {
          if (processError || code || signal.aborted) reject(processError ?? new Error(`RECORDING_STREAM_FAILED:${diagnostic || 'cancelled'}`))
          else resolve()
        }, reject)
      })
    })
    void done.catch(error => child.stdout.destroy(error))
    child.stdin.end(JSON.stringify({ ...source.config, ...options }) + '\n')
    // A canceled range/tone must release both its decoder and plugin worker.
    child.stdout.once('close', () => { if (!child.stdout.readableEnded && child.exitCode === null) abort() })
    return { audio: child.stdout, done, abort }
  }

  async renderRange(take: RecordingTake, durationMs: number, practice: PracticeState, effects: TrackEffects | null | undefined,
    sampleRate: number, startMs: number, endMs: number, target: string, signal: AbortSignal): Promise<string> {
    const stream = await this.takeStream(take, durationMs, practice, effects, sampleRate,
      { outputStartMs: startMs / practice.playbackRate, outputDurationMs: (endMs - startMs) / practice.playbackRate }, signal)
    try { await Promise.all([pipeline(stream.audio, createWriteStream(target), { signal }), stream.done]); return target }
    finally { stream.abort() }
  }

  async streamRange(take: RecordingTake, durationMs: number, practice: PracticeState, effects: TrackEffects | null | undefined,
    sampleRate: number, startMs: number, endMs: number, signal: AbortSignal): Promise<{ audio: Readable; done: Promise<void>; abort(): void }> {
    // The native stream's 80-byte WAV header is omitted for the backing mixer.
    return this.takeStream(take, durationMs, practice, effects, sampleRate, { outputStartMs: startMs / practice.playbackRate,
      outputDurationMs: (endMs - startMs) / practice.playbackRate, startByte: 80 }, signal)
  }

  async response(request: Request, takeId: string, pitch: number): Promise<Response> {
    const take = this.db.getRecordingTake(takeId), song = take ? this.db.getSong(take.songId) : null
    if (!take || !song) return new Response('Not found', { status: 404 })
    const sampleRate = take.sampleRate, frames = Math.ceil(song.durationMs / take.playbackRate * sampleRate / 1000), size = 80 + frames * 8
    const headers = mediaResponseHeaders('audio/wav', size)
    if (request.method === 'HEAD' || request.method === 'OPTIONS') return new Response(null, { status: request.method === 'HEAD' ? 200 : 204, headers })
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers })
    const range = request.headers.get('range'), parsed = range ? parseByteRange(range, size) : { start: 0, end: size - 1 }
    if (!parsed) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    const effects = song.recordingTracks.find(t => t.id === take.recordingTrackId)?.effects
    const stream = await this.takeStream(take, song.durationMs, { ...song.practice, playbackRate: take.playbackRate, pitchSemitones: take.pitchSemitones + pitch }, effects, sampleRate,
      { startByte: parsed.start, endByte: parsed.end }, request.signal)
    return new Response(Readable.toWeb(stream.audio) as BodyInit, { status: range ? 206 : 200,
      headers: { ...mediaResponseHeaders('audio/wav', parsed.end - parsed.start + 1),
        ...(range ? { 'Content-Range': `bytes ${parsed.start}-${parsed.end}/${size}` } : {}) } })
  }
}
