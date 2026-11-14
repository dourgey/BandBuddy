import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDefaultRecordingTrackState, type ExportRequest, type RecordingTake } from '../packages/shared/src/domain.js'
import { exportRequestSchema } from '../packages/shared/src/ipc.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { ExportService, exportRecordings } from '../src/main/exporter.js'
import { runProcess } from '../src/main/process.js'
vi.mock('electron', () => ({ dialog: {} }))
vi.mock('../src/main/process.js', () => ({ runProcess: vi.fn(async (_exe: string, args: string[]) => {
  await writeFile(args.at(-1)!, 'encoded audio')
  return { code: 0, stdout: '', stderr: '' }
}) }))
afterEach(() => vi.clearAllMocks())
const trackId = '00000000-0000-4000-8000-000000000010'
function setup(root: string) {
  const song = fixtureDetail(fixtureSongs[0]!)
  song.stems = []; song.practice.tracks = []
  song.recordingTracks = [{ ...createDefaultRecordingTrackState(song.id, trackId), name: '吉他', activeTakeId: 'take', gainDb: -6 }]
  song.recordingTakes = [{ id: 'take', recordingTrackId: trackId, playbackRate: .8, pitchSemitones: -2 } as RecordingTake]
  const request: ExportRequest = { songId: song.id, kind: 'stems', format: 'wav', stemTypes: [], recordingTrackIds: [trackId],
    outputPath: root, applyPlaybackRate: true, playbackRate: 1.2, applyPitchShift: true, pitchSemitones: 3,
    applyLoopRange: false, loopStartMs: null, loopEndMs: null, overwriteMode: 'rename', includeActiveTake: true }
  const database = { getSong: () => song, getSettings: () => ({ libraryRoot: root }), getActiveStemFiles: () => [],
    getRecordingTakeFile: () => ({ sourceRelPath: 'source.wav' }), createJob: vi.fn(() => 'job') }
  const service = new ExportService({ cacheRoot: root, resolveLibraryPath: (_root: string, rel: string) => path.join(root, rel) } as never,
    database as never, { tool: async () => 'ffmpeg' } as never, { info: vi.fn() } as never, vi.fn(), vi.fn())
  const render = vi.fn(async (...args: unknown[]) => { const target = args[7] as string; await writeFile(target, 'render'); return target })
  service.recordingPlayback = { renderRange: render } as never
  return { service, song, request, render }
}
describe('recording track export', () => {
  it('accepts recording-only requests and rejects empty/duplicate selections', () => {
    const { request } = setup('output')
    expect(exportRequestSchema.safeParse(request).success).toBe(true)
    expect(exportRequestSchema.safeParse({ ...request, recordingTrackIds: [] }).success).toBe(false)
    expect(exportRequestSchema.safeParse({ ...request, recordingTrackIds: [trackId, trackId] }).success).toBe(false)
  })
  it('exports a selected recording independently with placement, tone, speed, pitch and gain', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bb-export-'))
    try {
      const { service, request, song, render } = setup(root)
      const result = await service.start(request)
      expect(result.outputPaths).toHaveLength(1)
      expect(result.outputPaths[0]).toContain('REC 01 吉他.wav')
      await service.run(request, result.outputPaths, new AbortController().signal, vi.fn())
      expect(existsSync(result.outputPaths[0]!)).toBe(true)
      expect(render).toHaveBeenCalledWith(song.recordingTakes[0], song.durationMs,
        expect.objectContaining({ playbackRate: 1.2, pitchSemitones: 3 }), song.recordingTracks[0]!.effects, 44100, 0, song.durationMs, expect.any(String), expect.any(AbortSignal))
      expect(vi.mocked(runProcess).mock.calls[0]![1]).toContain('volume=-6dB')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('exports a recording-only mix across speed/pitch changes, respecting mute and solo', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bb-export-'))
    try {
      const { service, request, song, render } = setup(root)
      request.kind = 'mix'; request.outputPath = path.join(root, 'mix.wav')
      const result = await service.start(request)
      await service.run(request, result.outputPaths, new AbortController().signal, vi.fn())
      expect(render).toHaveBeenCalledOnce()
      expect(vi.mocked(runProcess).mock.calls[0]![1]).toContain('-filter_complex')
      song.recordingTracks[0]!.muted = true
      await expect(service.start(request)).rejects.toThrow('NO_AUDIBLE_TRACKS')
      request.kind = 'stems'; request.outputPath = root
      await expect(service.start(request)).resolves.toHaveProperty('jobId')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('does not silently substitute another track or omit a selected missing take', () => {
    const { song, request } = setup('output')
    expect(exportRecordings(song, { ...request, recordingTrackIds: [], includeActiveTake: true })).toEqual([])
    expect(() => exportRecordings(song, { ...request, recordingTrackIds: ['other'] })).toThrow('ACTIVE_RECORDING_TAKE_MISSING')
    song.recordingTracks[0]!.activeTakeId = null
    expect(() => exportRecordings(song, request)).toThrow('ACTIVE_RECORDING_TAKE_MISSING')
  })
})
