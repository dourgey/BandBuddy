import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ExportService } from '../src/main/exporter.js'
import { RecordingPlaybackService } from '../src/main/recording-playback.js'
import { runProcess } from '../src/main/process.js'
import { createDefaultRecordingTrackState, type ExportRequest, type RecordingTake } from '../packages/shared/src/domain.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
vi.mock('electron', () => ({ dialog: {} }))
const executable = path.resolve('resources/audio-host/win32-x64/bandbuddy-audio-host.exe')
const ffmpeg = path.resolve('resources/bin/ffmpeg.exe'), ffprobe = path.resolve('resources/bin/ffprobe.exe')

it.skipIf(process.platform !== 'win32' || ![executable, ffmpeg, ffprobe].every(existsSync))('encodes real recording-only exports to WAV, FLAC and MP3 with native timing and pitch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bb-recording-export-')), source = path.join(root, 'source.wav')
  try {
    expect((await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1:sample_rate=44100', '-c:a', 'pcm_f32le', source])).code).toBe(0)
    const song = fixtureDetail(fixtureSongs[0]!)
    song.durationMs = 2000; song.stems = []; song.practice.tracks = []
    song.recordingTracks = [{ ...createDefaultRecordingTrackState(song.id, 'track'), activeTakeId: 'take', gainDb: -6 }]
    song.recordingTakes = [{ id: 'take', songId: song.id, recordingTrackId: 'track', playbackRate: 1, pitchSemitones: 0,
      startPositionMs: 500, alignmentOffsetMs: 0, sampleRate: 44100, deviceSnapshot: { compactRecording: true } } as RecordingTake]
    const db = { getSong: () => song, getSettings: () => ({ libraryRoot: root }), getActiveStemFiles: () => [],
      getRecordingTakeFile: () => ({ sourceRelPath: source }), createJob: () => 'job' }
    const paths = { cacheRoot: root, audioHostExecutable: () => executable, resolveLibraryPath: () => source }
    const media = { tool: async () => ffmpeg }
    const exporter = new ExportService(paths as never, db as never, media as never, { info: vi.fn() } as never, vi.fn(), vi.fn())
    exporter.recordingPlayback = new RecordingPlaybackService(paths as never, db as never, media as never, {} as never, {} as never)
    for (const format of ['wav', 'flac', 'mp3'] as const) {
      for (const kind of ['stems', 'mix'] as const) {
        const request: ExportRequest = { songId: song.id, kind, format, stemTypes: [], recordingTrackIds: ['track'], includeActiveTake: true,
          outputPath: kind === 'mix' ? path.join(root, `mix.${format}`) : root, applyPlaybackRate: true, playbackRate: 1.25,
          applyPitchShift: true, pitchSemitones: 12, applyLoopRange: false, loopStartMs: null, loopEndMs: null, overwriteMode: 'rename' }
        const result = await exporter.start(request)
        await exporter.run(request, result.outputPaths, new AbortController().signal, vi.fn())
        const output = result.outputPaths[0]!
        const probe = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output])
        expect(probe.code).toBe(0)
        expect(Math.abs(Number(JSON.parse(probe.stdout).format.duration) - 1.6)).toBeLessThan(.06)
        if (format === 'wav' && kind === 'stems') {
          const raw = path.join(root, 'check.f32')
          expect((await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', output, '-f', 'f32le', '-ac', '1', raw])).code).toBe(0)
          const bytes = await readFile(raw), samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
          expect(Math.max(...samples.slice(0, 4410).map(Math.abs))).toBeLessThan(.0001)
          const crossings: number[] = []
          for (let f = 26460; f < 39690; f++) if (samples[f - 1]! <= 0 && samples[f]! > 0) crossings.push(f)
          expect(Math.abs((crossings.length - 1) * 44100 / (crossings.at(-1)! - crossings[0]!) - 440)).toBeLessThan(3)
          const steady = samples.slice(26460, 39690)
          const rms = Math.sqrt(steady.reduce((sum, sample) => sum + sample * sample, 0) / steady.length)
          expect(rms).toBeGreaterThan(.02)
          expect(rms).toBeLessThan(.07)
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30000)
