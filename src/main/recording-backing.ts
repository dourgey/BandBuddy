import { open } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { dbToGain, type RecordingStartRequest } from '@shared/domain.js'
import { practiceMix } from '@shared/practice-mix.js'
import { AudioPipeReader } from './audio-pipe.js'
import { LanPcmRenderer } from './lan-pcm.js'
import type { AppPaths } from './paths.js'
import type { BandBuddyDatabase } from './database.js'
import type { MediaService } from './media.js'
import type { RecordingPlaybackService } from './recording-playback.js'

/** A bounded producer for the device's file reader. Only 1 s ahead is decoded.
 * Speed/pitch and overdub effects keep their state across blocks. The raw spool
 * is private to the session and is removed after capture, including cancellation.
 */
export class RecordingBacking {
  readonly frames: number
  readonly done: Promise<void>
  private controller = new AbortController()
  private consumed = 0
  private primed = (() => {
    let resolve!: () => void, reject!: (error: unknown) => void
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
    return { promise, resolve, reject }
  })()
  private detach: () => void

  private constructor(private request: RecordingStartRequest, private startMs: number, private endMs: number,
    private sampleRate: number, private output: string, private paths: AppPaths, private db: BandBuddyDatabase,
    private media: MediaService, private playback: RecordingPlaybackService | undefined, signal: AbortSignal) {
    signal.throwIfAborted()
    this.frames = Math.ceil((endMs - startMs) / request.practice.playbackRate * sampleRate / 1000 - 1e-7)
    const abort = (): void => { this.controller.abort() }
    signal.addEventListener('abort', abort, { once: true })
    this.detach = () => signal.removeEventListener('abort', abort)
    this.done = this.run().catch(error => {
      this.primed.reject(error)
      if (!this.controller.signal.aborted) throw error
    }).finally(() => { this.detach(); this.controller.abort() })
    void this.done.catch(() => undefined)
    void this.primed.promise.catch(() => undefined)
  }

  static async create(request: RecordingStartRequest, startMs: number, endMs: number, sampleRate: number, output: string,
    paths: AppPaths, db: BandBuddyDatabase, media: MediaService, playback: RecordingPlaybackService | undefined,
    signal: AbortSignal): Promise<RecordingBacking> {
    const backing = new RecordingBacking(request, startMs, endMs, sampleRate, output, paths, db, media, playback, signal)
    const timer = setTimeout(() => backing.controller.abort(new Error('RECORDING_BACKING_PRIME_TIMEOUT')), 15000)
    try { await backing.primed.promise; signal.throwIfAborted(); return backing }
    catch (error) { await backing.dispose(); throw error }
    finally { clearTimeout(timer) }
  }

  advance(sourcePositionMs: number): void {
    this.consumed = Math.max(this.consumed, (sourcePositionMs - this.startMs) / this.request.practice.playbackRate * this.sampleRate / 1000)
  }

  dispose(): Promise<void> { this.controller.abort(); return this.done.catch(() => undefined) }

  private async run(): Promise<void> {
    const signal = this.controller.signal, song = this.db.getSong(this.request.songId)
    if (!song) throw new Error('SONG_NOT_FOUND')
    const tracks = this.db.getRecordingTracks(song.id)
    const gains = practiceMix({ ...song, recordingTracks: tracks }, this.request.practice).gains
    const root = this.db.getSettings().libraryRoot, master = dbToGain(this.request.practice.masterGainDb)
    const sources = this.db.getActiveStemFiles(song.id).filter(file => (gains.get(file.type) ?? 0) > 0).map(file => ({
      path: this.paths.resolveLibraryPath(root, file.relPath), drums: file.type === 'drums', gain: (gains.get(file.type) ?? 0) * master
    }))
    let renderer: LanPcmRenderer | undefined
    const recordings: Array<{ gain: number; reader: AudioPipeReader; abort(): void }> = []
    const file = await open(this.output, 'w')
    try {
      if (sources.length) {
        const ffmpeg = await this.media.tool('ffmpeg'); if (!ffmpeg) throw new Error('FFMPEG_MISSING')
        renderer = await LanPcmRenderer.create(ffmpeg, this.paths.audioHostExecutable(), sources, this.startMs / 1000,
          this.endMs / 1000, this.request.practice.playbackRate, this.request.practice.pitchSemitones ?? 0, signal, this.sampleRate)
      }
      for (const track of tracks) {
        if (track.id === this.request.recordingTrackId || !(gains.get(track.id)! > 0)) continue
        const take = song.recordingTakes.find(t => t.id === track.activeTakeId)
        if (!take) continue
        if (!this.playback) throw new Error('RECORDING_PLAYBACK_UNAVAILABLE')
        const stream = await this.playback.streamRange(take, song.durationMs, this.request.practice, track.effects,
          this.sampleRate, this.startMs, this.endMs, signal)
        recordings.push({ gain: gains.get(track.id)! * master,
          reader: new AudioPipeReader(stream.audio, stream.done.then(() => 0, () => -1)), abort: stream.abort })
      }
      let produced = 0
      const prime = Math.min(this.frames, Math.ceil(this.sampleRate / 4))
      while (produced < this.frames) {
        signal.throwIfAborted()
        // Backpressure follows the device clock, including count-in and pause.
        if (produced - this.consumed >= this.sampleRate) { await delay(5, undefined, { signal }); continue }
        const block = await renderer?.next(), frames = block?.frames ?? Math.min(960, this.frames - produced)
        if (renderer && !block) throw new Error('RECORDING_BACKING_EARLY_EOF')
        const pcm = block?.pcm ?? Buffer.alloc(frames * 8)
        for (const recording of recordings) {
          const input = await recording.reader.read(pcm.length)
          for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(pcm.readFloatLE(offset) + input.readFloatLE(offset) * recording.gain, offset)
        }
        for (let offset = 0; offset < pcm.length; offset += 4) if (!Number.isFinite(pcm.readFloatLE(offset))) throw new Error('RECORDING_BACKING_NONFINITE')
        await file.writeFile(pcm)
        produced += frames
        if (produced >= prime) this.primed.resolve()
      }
    } finally {
      renderer?.dispose()
      for (const recording of recordings) recording.abort()
      await file.close()
    }
  }
}
