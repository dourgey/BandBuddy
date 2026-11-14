import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { RecordingPlaybackService } from '../src/main/recording-playback.js'
import { RecordingService } from '../src/main/recording.js'
import { createDefaultPracticeState, type RecordingTake } from '../packages/shared/src/domain.js'
vi.mock('electron', () => ({ dialog: {}, systemPreferences: {} }))
const executable = path.resolve('resources/audio-host/win32-x64/bandbuddy-audio-host.exe')

it.skipIf(process.platform !== 'win32' || !existsSync(executable))('deletes a recording track on the first request while its real native WAV response is still streaming', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-reader-delete-'))
  const takeRoot = path.join(root, 'recordings', 'take'), source = path.join(takeRoot, 'source.wav')
  await mkdir(takeRoot, { recursive: true })
  const samples = 44100, bytes = Buffer.alloc(44 + samples * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(44100 * 4, 28)
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 4, 40)
  await writeFile(source, bytes)
  const take = { id: 'take', songId: 'song', recordingTrackId: 'track', playbackRate: 1, pitchSemitones: 0,
    startPositionMs: 0, alignmentOffsetMs: 0, sampleRate: 44100, deviceSnapshot: { compactRecording: true } } as RecordingTake
  let deleted = false, trackDeleted = false
  const song = { durationMs: 30 * 60_000, practice: createDefaultPracticeState('song'), recordingTracks: [{ id: 'track' }] }
  const db = { getRecordingTake: () => deleted ? null : take, getSong: () => song,
    getRecordingTakeFile: () => deleted ? null : { songId: 'song', sourceRelPath: source },
    getSettings: () => ({ libraryRoot: root }), deleteRecordingTake: () => { deleted = true },
    getRecordingTrack: () => trackDeleted ? null : { id: 'track' },
    sqlite: { prepare: (sql: string) => sql.startsWith('SELECT') ? { all: () => [{ id: 'take' }] } : { run: () => { trackDeleted = true } } } }
  const paths = { audioHostExecutable: () => executable, resolveLibraryPath: () => source, songDirectory: () => root }
  const playback = new RecordingPlaybackService(paths as never, db as never, {} as never, {} as never, {} as never)
  const service = { isActive: () => false, waveformJobs: new Map(), database: db, paths, playback, changed: vi.fn(), logger: { warn: vi.fn() },
    deleteTake: (id: string): Promise<void> => RecordingService.prototype.deleteTake.call(service as never, id) }
  try {
    const response = await playback.response(new Request('http://localhost/take'), take.id, 0)
    const reader = response.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0)
    // Do not drain the 30 minute response: it deliberately retains an open
    // decoder and Windows handle, reproducing deletion during loaded playback.
    await RecordingService.prototype.deleteTrack.call(service as never, 'track')
    expect(deleted).toBe(true)
    expect(trackDeleted).toBe(true)
    expect(existsSync(takeRoot)).toBe(false)
    expect(service.changed).toHaveBeenCalledTimes(2)
    await reader.cancel().catch(() => undefined)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 15000)

it('waits for an in-flight source preparation, closes it, and blocks new readers during deletion', async () => {
  const service = new RecordingPlaybackService({} as never, {} as never, {} as never, {} as never, {} as never)
  let prepared!: (source: { config: {}; dispose(): Promise<void> }) => void
  const dispose = vi.fn(async () => undefined)
  vi.spyOn(service, 'open').mockImplementation(() => new Promise(resolve => { prepared = resolve }))
  const take = { id: 'take' } as RecordingTake
  const practice = createDefaultPracticeState('song'), action = vi.fn(async () => undefined)
  const stream = service.streamRange(take, 1000, practice, null, 44100, 0, 1000, new AbortController().signal)
  const rejected = expect(stream).rejects.toThrow()
  const deletion = service.withoutReaders('take', action)
  expect(action).not.toHaveBeenCalled()
  await expect(service.streamRange(take, 1000, practice, null, 44100, 0, 1000, new AbortController().signal)).rejects.toThrow('RECORDING_TAKE_DELETING')
  prepared({ config: {}, dispose })
  await rejected; await deletion
  expect(dispose).toHaveBeenCalledOnce()
  expect(action).toHaveBeenCalledOnce()
})
