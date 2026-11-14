import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BeatThisService } from '../src/main/beat-this.js'
import { MediaService } from '../src/main/media.js'

const mocks = vi.hoisted(() => ({ run: vi.fn(), valid: vi.fn(), download: vi.fn(), close: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false }, protocol: {} }))
vi.mock('../src/main/process.js', () => ({ runProcess: mocks.run, processFailure: (_: unknown, code: string) => new Error(code) }))
vi.mock('../src/main/artifact-download.js', () => ({ artifactValid: mocks.valid }))
vi.mock('../src/main/runtime-network.js', () => ({ RuntimeNetwork: class { download = mocks.download; close = mocks.close } }))

describe('Beat This integration', () => {
  let root: string
  const analysis = { bpm: 123.4, beatOffsetMs: 137, confidence: 0.95 }
  beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-beat-test-'))
    mocks.valid.mockResolvedValue(true)
    mocks.download.mockResolvedValue('model')
    mocks.run.mockImplementation(async (_command: string, args: string[]) => ({
      code: 0, termination: 'exited', stderr: '',
      stdout: args.includes('--audio') ? JSON.stringify({ type: 'result', analysis }) : ''
    }))
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function service() {
    return new BeatThisService({ cacheRoot: root } as never,
      { getSettings: () => ({ modelRoot: root, preferredDevice: 'cpu', network: {} }) } as never,
      { pythonExecutable: () => process.execPath, getInfo: () => ({ selectedDevice: 'cuda' }) } as never)
  }

  it('uses verified local assets offline, decodes through FFmpeg, and removes temporary audio', async () => {
    await expect(service().detect('ffmpeg', [{ path: '/音乐/a.flac', gain: 2 }, { path: '/音乐/b.mp3', gain: 1 }])).resolves.toEqual(analysis)
    expect(mocks.download).not.toHaveBeenCalled()
    const decode = mocks.run.mock.calls[0]!
    expect(decode[1]).toContain('[0:a:0]volume=2[b0];[1:a:0]volume=1[b1];[b0][b1]amix=inputs=2:duration=longest:normalize=0[out]')
    expect(mocks.run.mock.calls[1]![1]).toContain('cpu')
    expect(await readdir(root)).toEqual([])
  })

  it('downloads a missing or corrupt checkpoint before inference', async () => {
    mocks.valid.mockImplementation(async (file: string) => file.endsWith('.whl'))
    await service().detect('ffmpeg', [{ path: '/a.wav', gain: 1 }])
    expect(mocks.download).toHaveBeenCalledOnce()
    expect(mocks.download.mock.calls[0]![0]).toMatchObject({ id: 'beat-this-final0', size: 81058141 })
  })

  it('fails closed on package integrity errors before decoding', async () => {
    mocks.valid.mockResolvedValue(false)
    await expect(service().detect('ffmpeg', [{ path: '/a.wav', gain: 1 }])).rejects.toThrow('BPM_PACKAGE_INVALID')
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('rejects silence, invalid model output and decoder errors without leaking temp files', async () => {
    const detector = service()
    for (const value of [null, { ...analysis, bpm: 0 }, { ...analysis, confidence: 2 }, { ...analysis, beatOffsetMs: 5000 }]) {
      mocks.run.mockImplementation(async (_cmd: string, args: string[]) => ({ code: 0, termination: 'exited', stderr: '',
        stdout: args.includes('--audio') ? JSON.stringify({ type: 'result', analysis: value }) : '' }))
      await expect(detector.detect('ffmpeg', [{ path: '/a.wav', gain: 1 }])).rejects.toThrow(value === null ? 'UNSTABLE' : 'INVALID_RESULT')
      expect(await readdir(root)).toEqual([])
    }
    mocks.run.mockResolvedValue({ code: 1, termination: 'exited', stdout: '', stderr: 'bad audio' })
    await expect(detector.detect('ffmpeg', [{ path: '/a.wav', gain: 1 }])).rejects.toThrow('DECODE_FAILED')
    expect(await readdir(root)).toEqual([])
  })

  it('bounds concurrent work and stops accepting work after shutdown', async () => {
    const detector = service()
    let release!: () => void
    mocks.valid.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true) }))
    const first = detector.detect('ffmpeg', [{ path: '/a.wav', gain: 1 }])
    await expect(detector.detect('ffmpeg', [{ path: '/b.wav', gain: 1 }])).rejects.toThrow('BUSY')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await first
    detector.shutdown()
    await expect(detector.detect('ffmpeg', [{ path: '/a.wav', gain: 1 }])).rejects.toThrow()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  function media(source: string | null = null) {
    const database = {
      getSong: vi.fn(() => ({ durationMs: 60_000 })),
      getSongRow: () => ({ source_rel_path: source }),
      getSettings: () => ({ libraryRoot: root }),
      getActiveStemFiles: () => [
        { type: 'vocals', relPath: 'vocals.flac', encodingGain: 0.5 },
        { type: 'lead_vocals', relPath: 'lead.flac', encodingGain: 1 },
        { type: 'drums', relPath: 'drums.flac', encodingGain: 1 },
        { type: 'guitar', relPath: 'guitar.flac', encodingGain: 1 },
        { type: 'lead_guitar', relPath: 'lead-guitar.flac', encodingGain: 1 }
      ],
      updateSong: vi.fn()
    }
    const media = new MediaService({ resolveLibraryPath: (base: string, file: string) => path.join(base, file) } as never,
      database as never, { info: vi.fn() } as never)
    vi.spyOn(media, 'tool').mockResolvedValue('ffmpeg')
    media.bpmPredictor = vi.fn().mockResolvedValue(analysis)
    return { media, database }
  }

  it('prefers the original mix and persists model BPM and phase', async () => {
    await writeFile(path.join(root, 'original.mp3'), 'fixture')
    const { media: m, database } = media('original.mp3')
    const result = await m.detectBpm('song')
    expect(m.bpmPredictor).toHaveBeenCalledWith('ffmpeg', [{ path: path.join(root, 'original.mp3'), gain: 1 }])
    expect(database.updateSong).toHaveBeenCalledWith('song', { bpm: 123.4, beatOffsetMs: 137 })
    expect(result).toEqual({ ...analysis, analyzedStem: 'mix', model: 'beat-this-final0' })
  })

  it('reconstructs missing originals without doubling refined stems and coalesces duplicate clicks', async () => {
    const { media: m, database } = media('deleted.mp3')
    const one = m.detectBpm('song')
    const two = m.detectBpm('song')
    expect(one).toBe(two)
    await one
    expect(m.bpmPredictor).toHaveBeenCalledWith('ffmpeg', [
      { path: path.join(root, 'vocals.flac'), gain: 2 },
      { path: path.join(root, 'drums.flac'), gain: 1 },
      { path: path.join(root, 'guitar.flac'), gain: 1 }
    ])
    expect(database.updateSong).toHaveBeenCalledOnce()
  })

  it('never changes saved tempo when model inference fails', async () => {
    const { media: m, database } = media()
    m.bpmPredictor = vi.fn().mockRejectedValue(new Error('BPM_DETECTION_UNSTABLE'))
    await expect(m.detectBpm('song')).rejects.toThrow('UNSTABLE')
    expect(database.updateSong).not.toHaveBeenCalled()
  })
})
