import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { AppPaths } from '../src/main/paths.js'
import { BandBuddyDatabase } from '../src/main/database.js'
import { AudioHostClient } from '../src/main/audio-host.js'
import { RecordingService } from '../src/main/recording.js'
import { NativeAudioService } from '../src/main/native-audio.js'
import { ArsenalService } from '../src/main/arsenal.js'
import { MediaService } from '../src/main/media.js'
import { RecordingPlaybackService } from '../src/main/recording-playback.js'
import { defaultEffectChain } from '../packages/shared/src/arsenal.js'
import { runProcess } from '../src/main/process.js'

vi.mock('electron', () => ({ app: { isPackaged: false }, protocol: {}, dialog: {} }))
vi.mock('../src/main/process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/process.js')>()
  return { ...actual, spawnSafe: (file: string, args: string[], ...rest: unknown[]) =>
    actual.spawnSafe(file, path.basename(file) === 'bandbuddy-audio-host.exe' && (!args.length || args[0] === '--probe-backend') ? ['--simulate'] : args, ...rest as []) }
})
vi.mock('../src/main/media-analysis.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/media-analysis.js')>()
  const runner = actual.createMediaAnalysisRunner(pathToFileURL(path.resolve('out/main/analysis-worker.js')))
  return { ...actual, runMediaAnalysis: runner }
})

// Use Electron's matching SQLite ABI, real FFmpeg, and the native host's synthetic
// input device. No microphone, user database, or user library is touched.
it.skipIf(!process.versions.electron || !existsSync('out/main/analysis-worker.js'))('publishes raw capture immediately and streams wet playback without waiting for peaks or a whole-song render', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'BandBuddy recording roundtrip-'))
  const paths = Object.assign(Object.create(AppPaths.prototype) as AppPaths, {
    dataRoot: root, localRoot: root, databasePath: path.join(root, 'test.db'), backupRoot: path.join(root, 'backups'),
    cacheRoot: path.join(root, 'cache'), downloadRoot: path.join(root, 'downloads'), logsRoot: path.join(root, 'logs'), jobsRoot: path.join(root, 'jobs'),
    pythonRoot: path.join(root, 'python'), modelRoot: path.join(root, 'models'), toolsRoot: path.resolve('resources/bin'), defaultLibraryRoot: path.join(root, 'music'),
    audioHostExecutable: () => path.resolve('resources/audio-host/win32-x64/bandbuddy-audio-host.exe')
  })
  paths.ensure()
  const db = new BandBuddyDatabase(paths)
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const host = new AudioHostClient(paths, logger as never)
  const media = new MediaService(paths, db, logger as never)
  vi.spyOn(media, 'tool').mockImplementation(async name => path.resolve(`resources/bin/${name}.exe`))
  const phases: string[] = []
  const recording = new RecordingService(paths, db, media, host, logger as never, s => phases.push(s.phase), () => {}, () => {})
  const arsenal = new ArsenalService(paths, db, media, host, recording, () => {}, () => {}, () => false)
  recording.arsenal = arsenal
  const sourcePlayback = new RecordingPlaybackService(paths, db, media, arsenal, host)
  recording.playback = sourcePlayback
  media.recordingPlayback = (request, takeId, pitch) => sourcePlayback.response(request, takeId, pitch)
  const offlineRender = vi.spyOn(arsenal, 'render').mockRejectedValue(new Error('Playback must not render a whole file'))
  const generatePeaks = media.generatePeaks.bind(media)
  let releasePeaks = (): void => {}
  let peaksBlocked = new Promise<void>(resolve => { releasePeaks = resolve })
  vi.spyOn(media, 'generatePeaks').mockImplementation(async (...args) => { await peaksBlocked; return generatePeaks(...args) })
  const playback = new NativeAudioService(paths, db, media, host, arsenal, () => {})
  const timings: unknown[] = []
  try {
    const [device] = await host.devices()
    const settings = db.getSettings()
    settings.recordingAudio = { ...settings.recordingAudio, backend: device!.backend, inputDeviceId: device!.id, outputDeviceId: device!.id, inputChannelMode: 'stereo', inputChannels: [0, 1], sampleRate: 48000, bufferFrames: 128, desktopEngine: 'native' }
    db.saveSettings(settings)
    const backing = path.join(settings.libraryRoot, 'backing.wav')
    const result = await runProcess(path.resolve('resources/bin/ffmpeg.exe'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_f32le', backing])
    expect(result.code).toBe(0)
    const songId = db.createSong({ title: 'Recording roundtrip', artist: '', sourceRelPath: null, sourceHash: null, sourceFormat: 'existing-stems', durationMs: 4000, sampleRate: 48000, channels: 2, artworkRelPath: null, status: 'ready' })
    db.activateSeparation(songId, 'test-job', 'test', 'cpu', [{ type: 'vocals', relPath: 'backing.wav', peaksRelPath: null, durationMs: 4000, sampleRate: 48000, channels: 2 }])
    const track = db.createRecordingTrack(songId)
    const chain = { ...defaultEffectChain(), modules: [], outputGainDb: -6 }
    // Persist a selected wet tone and monitoring preference without opening it yet.
    db.sqlite.prepare('UPDATE recording_tracks SET effects_json=? WHERE id=?').run(JSON.stringify({ enabled: true, presetId: null, monitorMode: 'wet', chain }), track.id)
    let song = db.getSong(songId)!
    await playback.load(songId, song.practice)
    await playback.command('pause')
    for (const order of ['refresh-first', 'monitor-first']) {
      await recording.start({ songId, recordingTrackId: track.id, positionMs: 0, practice: song.practice })
      await vi.waitFor(() => expect(recording.getState().sourcePositionMs).toBeGreaterThan(200), { timeout: 5000 })
      const stopStart = performance.now(), take = await recording.stop(), stopMs = performance.now() - stopStart
      expect(stopMs).toBeLessThan(1000)
      expect(take?.durationMs).toBeGreaterThan(100)
      expect(recording.getState().phase).toBe('idle')
      song = db.getSong(songId)!
      expect(song.recordingTracks.find(t => t.id === track.id)?.activeTakeId).toBe(take!.id)
      const file = db.getRecordingTakeFile(take!.id)!
      expect(file.sourceRelPath).toMatch(/source\.wav$/)
      expect(file.previewRelPath).toBe(file.sourceRelPath)
      expect(existsSync(paths.resolveLibraryPath(settings.libraryRoot, file.sourceRelPath))).toBe(true)
      // Thirty minutes of virtual timeline must not make a 125 ms read wait
      // for thirty minutes of DSP, and pending waveform analysis cannot gate it.
      db.sqlite.prepare('UPDATE songs SET duration_ms=? WHERE id=?').run(1_800_000, songId)
      const streamStart = performance.now()
      const response = await media.handleProtocolRequest(new Request(take!.previewMediaUrl, { headers: { Range: 'bytes=0-48079' } }))
      const pcm = Buffer.from(await response.arrayBuffer()), streamMs = performance.now() - streamStart
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Range')).toBe('bytes 0-48079/691200080')
      expect(pcm.length).toBe(48080)
      expect(pcm.subarray(0, 4).toString()).toBe('RIFF')
      let wetPeak = 0
      for (let offset = 80; offset < pcm.length; offset += 4) wetPeak = Math.max(wetPeak, Math.abs(pcm.readFloatLE(offset)))
      expect(wetPeak).toBeGreaterThan(.001)
      expect(streamMs).toBeLessThan(1000)
      if (order === 'refresh-first') expect(db.getRecordingTakeFile(take!.id)?.peaksRelPath).toBeNull()
      db.sqlite.prepare('UPDATE songs SET duration_ms=? WHERE id=?').run(4000, songId)
      releasePeaks(); peaksBlocked = Promise.resolve()
      await vi.waitFor(() => expect(db.getRecordingTakeFile(take!.id)?.peaksRelPath).toBeTruthy(), { timeout: 5000 })
      const peaks = JSON.parse(await readFile(paths.resolveLibraryPath(settings.libraryRoot, db.getRecordingTakeFile(take!.id)!.peaksRelPath!), 'utf8'))
      expect(Math.max(...peaks.max)).toBeGreaterThan(.01)
      // Solo the saved take so playback metering cannot be satisfied by backing.
      db.updateRecordingTrackState(track.id, { solo: true })
      if (order === 'refresh-first') {
        await playback.refresh(songId)
        await arsenal.monitor('wet', chain, track.id)
        expect(host.hasActiveTimeline()).toBe(false)
      } else {
        await arsenal.monitor('wet', chain, track.id)
        await playback.refresh(songId)
        expect(host.hasActiveTimeline()).toBe(true)
      }
      await playback.command('play')
      expect(host.hasActiveTimeline()).toBe(true)
      const graph = (host as unknown as { timelineGraph: { tracks: Array<{ id: string; gain: number; path: string }> } }).timelineGraph
      expect(graph.tracks.find(t => t.id === track.id)).toMatchObject({ gain: 1 })
      expect(graph.tracks.find(t => t.id === 'vocals')?.gain).toBe(0)
      // Stop input monitoring; reopen output-only playback and verify the take's signal.
      await playback.command('pause'); await arsenal.stopMonitor()
      await playback.command('seek', { positionMs: 0 })
      let peak = 0
      const off = host.onEvent(e => { if (e.event === 'meter' && e.data.timeline?.playing) peak = Math.max(peak, e.data.outputPeak ?? 0, e.data.diagnostics?.finalPeak ?? 0) })
      await playback.command('play')
      await vi.waitFor(() => expect(peak).toBeGreaterThan(.001), { timeout: 5000 })
      off(); await playback.command('pause')
      timings.push({ order, stopMs, streamMs, wetPeak, durationMs: take!.durationMs, waveformPeak: Math.max(...peaks.max), playbackPeak: peak })
    }
    expect(phases).toContain('finalizing')
    expect(phases).not.toContain('failed')
    expect(db.getSong(songId)!.recordingTakes).toHaveLength(2)
    // The saved take remains playable at another practice speed/key, including
    // as backing for a new recording. This exercises actual pitch/effects/tempo.
    const changedPractice = { ...song.practice, playbackRate: .75, pitchSemitones: 3, positionMs: 0 }
    await playback.update(changedPractice)
    await playback.command('seek', { positionMs: 0 })
    let transformedPeak = 0
    const off = host.onEvent(e => { if (e.event === 'meter' && e.data.timeline?.playing) transformedPeak = Math.max(transformedPeak, e.data.outputPeak ?? 0, e.data.diagnostics?.finalPeak ?? 0) })
    await playback.command('play')
    await vi.waitFor(() => expect(transformedPeak).toBeGreaterThan(.001), { timeout: 5000 })
    off(); await playback.command('pause')
    const overdub = db.createRecordingTrack(songId), backingOutput = path.join(root, 'overdub.wav')
    await (recording as unknown as { renderBacking(...args: unknown[]): Promise<void> }).renderBacking(
      { songId, recordingTrackId: overdub.id, practice: changedPractice }, 0, 4000, 48000, backingOutput, new AbortController().signal)
    const volume = await runProcess(path.resolve('resources/bin/ffmpeg.exe'), ['-hide_banner', '-i', backingOutput, '-af', 'volumedetect', '-f', 'null', '-'])
    expect(volume.code).toBe(0)
    expect(volume.stderr).toMatch(/max_volume: -?\d+(?:\.\d+)? dB/)
    expect((await media.probe(backingOutput)).durationMs).toBeCloseTo(4000 / .75, -1)
    expect(offlineRender).not.toHaveBeenCalled()
    await writeFile(path.join(tmpdir(), 'bandbuddy-recording-latency.json'), JSON.stringify(timings, null, 2))
    // Emulate a process exit after the WAV rename but before SQLite commit.
    await recording.start({ songId, recordingTrackId: overdub.id, positionMs: 0, practice: song.practice })
    await vi.waitFor(() => expect(recording.getState().sourcePositionMs).toBeGreaterThan(100), { timeout: 5000 })
    const session = (recording as unknown as { active: { sessionRoot: string; capturePath: string } }).active
    const captured = await host.stop(), publishedId = randomUUID()
    const metadata = await readFile(path.join(session.sessionRoot, 'session.json'), 'utf8')
    const published = path.join(paths.songDirectory(settings.libraryRoot, songId), 'recordings', publishedId, 'source.wav')
    await mkdir(path.dirname(published), { recursive: true })
    const publication = JSON.stringify({ takeId: publishedId, result: captured })
    await writeFile(path.join(session.sessionRoot, 'publish.json'), publication)
    await rename(session.capturePath, published)
    Object.assign(recording, { active: null })
    const recovered = new RecordingService(paths, db, media, host, logger as never, () => {}, () => {}, () => {})
    try {
      await recovered.recoverInterruptedSessions()
      expect(db.getRecordingTake(publishedId)?.interrupted).toBe(true)
      expect(db.getSong(songId)!.recordingTakes).toHaveLength(3)
      expect(existsSync(published)).toBe(true)
      // A crash after the commit must not create a duplicate on restart.
      const stale = path.join(paths.songDirectory(settings.libraryRoot, songId), '.recording-sessions', 'committed')
      await mkdir(stale, { recursive: true }); await writeFile(path.join(stale, 'session.json'), metadata); await writeFile(path.join(stale, 'publish.json'), publication)
      await recovered.recoverInterruptedSessions()
      expect(db.getSong(songId)!.recordingTakes).toHaveLength(3)
      expect(existsSync(stale)).toBe(false)
    } finally { await recovered.shutdown() }
  } finally {
    releasePeaks()
    await playback.command('unload').catch(() => {})
    await arsenal.stopMonitor().catch(() => {}); await recording.shutdown(); db.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60000)
