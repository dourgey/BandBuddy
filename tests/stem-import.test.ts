import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportService } from '../src/main/imports.js'
import { importStemsSchema } from '@shared/ipc.js'
vi.mock('electron', () => ({ dialog: {}, shell: {} }))

describe('existing stems import', () => {
  let root = ''
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
  async function setup(durations = [1000, 1000]) {
    root = await mkdtemp(path.join(tmpdir(), 'stem-import-'))
    const files = [{ path: path.join(root, 'vocals.wav'), type: 'vocals' as const, name: '人声' }, { path: path.join(root, 'guitar.wav'), type: 'guitar' as const, name: '吉他 · 左声道' }]
    for (const file of files) await writeFile(file.path, 'audio')
    const database = { getSettings: () => ({ libraryRoot: root }), createSong: vi.fn(), createJob: vi.fn(() => 'job'), deleteSongRecord: vi.fn() }
    const changed = vi.fn(); const kick = vi.fn()
    const service = new ImportService({ songDirectory: (_: string, id: string) => path.join(root, id), toLibraryRelative: (_: string, file: string) => path.relative(root, file) } as never,
      database as never, { ready: async () => {}, toolsReady: () => true, probe: vi.fn(async () => ({ durationMs: durations.shift() })) } as never, {} as never, {} as never, changed, kick)
    return { service, files, database, changed, kick }
  }
  it('queues normalization without requiring a separation runtime and preserves custom names', async () => {
    const { service, files, database, changed, kick } = await setup()
    const result = await service.importStems({ files, title: '乐队排练' })
    expect(result.songId).toBeTruthy(); expect(result.jobId).toBe('job')
    expect(database.createSong).toHaveBeenCalledWith(expect.objectContaining({ sourceFormat: 'existing-stems', title: '乐队排练', sourceRelPath: null }), result.songId)
    const payload = database.createJob.mock.calls[0] as unknown as unknown[]
    expect(payload[0]).toBe('normalizeStems')
    expect(payload[4]).toMatchObject({ files: [{ name: '人声' }, { name: '吉他 · 左声道' }] })
    expect(await readFile(path.join(root, result.songId!, 'source-stems', 'guitar.wav'), 'utf8')).toBe('audio')
    expect(changed).toHaveBeenCalledOnce(); expect(kick).toHaveBeenCalledOnce()
  })
  it('asks for padding before creating a song when durations differ', async () => {
    const { service, files, database } = await setup([1000, 2200])
    expect(await service.importStems({ files })).toMatchObject({ songId: null, needsPadding: true, durationDifferenceMs: 1200 })
    expect(database.createSong).not.toHaveBeenCalled()
  })
  it('rolls back copied files and song record after queue creation fails', async () => {
    const { service, files, database } = await setup()
    database.createJob.mockImplementation(() => { throw new Error('database full') })
    await expect(service.importStems({ files })).rejects.toThrow('database full')
    expect(database.deleteSongRecord).toHaveBeenCalledOnce()
    expect((await readdir(root)).sort()).toEqual(['guitar.wav', 'vocals.wav'])
  })
  it('rejects duplicate slots, blank names and fewer than two files at the IPC boundary', () => {
    const file = { path: '/tmp/guitar.wav', type: 'guitar', name: '吉他' }
    expect(importStemsSchema.safeParse({ files: [file] }).success).toBe(false)
    expect(importStemsSchema.safeParse({ files: [file, file] }).success).toBe(false)
    expect(importStemsSchema.safeParse({ files: [file, { ...file, type: 'vocals', name: '  ' }] }).success).toBe(false)
    expect(importStemsSchema.safeParse({ files: [file, { ...file, type: 'vocals', name: '主唱' }] }).success).toBe(true)
  })
})
