import { expect, it, vi } from 'vitest'
import { RecordingService } from '../src/main/recording.js'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
vi.mock('electron', () => ({ dialog: {}, systemPreferences: {} }))
it('deletes only takes belonging to the requested recording track before removing it', async () => {
  const run = vi.fn(), all = vi.fn(() => [{id:'take-a'},{id:'take-b'}]), remove = vi.fn(async (_takeId: string) => undefined)
  const service = { isActive: () => false, database: { getRecordingTrack: () => ({id:'track-a'}), sqlite: { prepare: vi.fn((sql: string) => sql.startsWith('SELECT') ? {all} : {run}) } }, deleteTake: remove, changed: vi.fn() }
  await RecordingService.prototype.deleteTrack.call(service as never, 'track-a')
  expect(all).toHaveBeenCalledWith('track-a')
  expect(remove.mock.calls.map(call => call[0])).toEqual(['take-a','take-b'])
  expect(run).toHaveBeenCalledWith('track-a')
  expect(service.changed).toHaveBeenCalledOnce()
  service.isActive = () => true
  await expect(RecordingService.prototype.deleteTrack.call(service as never, 'track-a')).rejects.toThrow('请先停止录音')
  expect(run).toHaveBeenCalledOnce()
})

it('releases readers and retries a sharing violation within the first deletion, retaining the track', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-delete-'))
  const takeRoot = path.join(root, 'recordings', 'take-a'), source = path.join(takeRoot, 'source.wav')
  await mkdir(takeRoot, { recursive: true }); await writeFile(source, 'audio')
  let row = true
  const release = vi.fn(async () => undefined)
  const deleted = vi.fn(() => { row = false })
  const service = { isActive: () => false, waveformJobs: new Map(), beforeDeleteTake: release,
    database: { getRecordingTakeFile: () => row ? { songId: 'song', sourceRelPath: 'source' } : null, getSettings: () => ({ libraryRoot: root }), deleteRecordingTake: deleted },
    paths: { resolveLibraryPath: () => source, songDirectory: () => root }, changed: vi.fn(), logger: { warn: vi.fn() } }
  try {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    await RecordingService.prototype.deleteTake.call(service as never, 'take-a')
    expect(release).toHaveBeenCalledWith('take-a')
    expect(deleted).toHaveBeenCalledExactlyOnceWith('take-a')
    expect(service.changed).toHaveBeenCalledOnce()
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }); vi.mocked(rename).mockClear() }
})

it('preserves metadata on a file error and restores the whole take if its database deletion fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-delete-'))
  const takeRoot = path.join(root, 'recordings', 'take-a'), source = path.join(takeRoot, 'source.wav')
  await mkdir(takeRoot, { recursive: true }); await writeFile(source, 'audio')
  const deleted = vi.fn()
  const service = { isActive: () => false, waveformJobs: new Map(),
    database: { getRecordingTakeFile: () => ({ songId: 'song', sourceRelPath: 'source' }), getSettings: () => ({ libraryRoot: root }), deleteRecordingTake: deleted },
    paths: { resolveLibraryPath: () => source, songDirectory: () => root }, changed: vi.fn(), logger: { warn: vi.fn() } }
  try {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('disk error'), { code: 'EIO' }))
    await expect(RecordingService.prototype.deleteTake.call(service as never, 'take-a')).rejects.toThrow('disk error')
    expect(deleted).not.toHaveBeenCalled()
    expect(await readFile(source, 'utf8')).toBe('audio')
    deleted.mockImplementationOnce(() => { throw new Error('database locked') })
    await expect(RecordingService.prototype.deleteTake.call(service as never, 'take-a')).rejects.toThrow('database locked')
    expect(await readFile(source, 'utf8')).toBe('audio')
    expect(service.changed).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }); vi.mocked(rename).mockClear() }
})

it('restores a staged take after a crash before commit and cleans a committed deletion at startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-delete-recover-'))
  const retained = '11111111-1111-4111-8111-111111111111', removed = '22222222-2222-4222-8222-222222222222'
  const nonce = '33333333-3333-4333-8333-333333333333'
  for (const id of [retained, removed]) {
    const directory = path.join(root, 'recordings', `.deleted-${id}-${nonce}`)
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'source.wav'), 'audio')
  }
  const service = { recovering: false, active: null,
    database: { getSettings: () => ({ libraryRoot: root }), listSongs: () => [{ id: 'song' }], getSong: () => ({ recordingTakes: [] }), getRecordingTake: (id: string) => id === retained ? { id } : null },
    paths: { songDirectory: () => root }, logger: { warn: vi.fn() } }
  try {
    await RecordingService.prototype.recoverInterruptedSessions.call(service as never)
    expect(await readFile(path.join(root, 'recordings', retained, 'source.wav'), 'utf8')).toBe('audio')
    await expect(readFile(path.join(root, 'recordings', `.deleted-${removed}-${nonce}`, 'source.wav'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
