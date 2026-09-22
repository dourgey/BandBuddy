import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMediaAnalysisRunner } from '../src/main/media-analysis.js'
import { removeTestAnalysisWorker, testAnalysisWorker } from './helpers/analysis-worker.js'

const ffmpeg = path.resolve('resources/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
describe.skipIf(!existsSync(ffmpeg))('media analysis worker', () => {
  let run: ReturnType<typeof createMediaAnalysisRunner>
  beforeAll(async () => { run = createMediaAnalysisRunner(await testAnalysisWorker()) })
  afterAll(removeTestAnalysisWorker)

  it('streams PCM peaks on a real worker and preserves the persisted peak format', async () => {
    let heartbeats = 0
    const timer = setInterval(() => { heartbeats += 1 }, 1)
    const peaks = await run({ kind: 'peaks', ffmpeg, sampleRate: 44100, durationMs: 1000, bins: 100,
      args: ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1']
    })
    clearInterval(timer)
    expect(heartbeats).toBeGreaterThan(0)
    expect(peaks.version).toBe(1)
    expect(peaks.min).toHaveLength(100)
    expect(peaks.max).toHaveLength(100)
    expect(peaks.min.every(value => value < -4000 && value > -4200)).toBe(true)
    expect(peaks.max.every(value => value > 4000 && value < 4200)).toBe(true)
  })

  it('releases failed workers and accepts subsequent analysis', async () => {
    await expect(run({ kind: 'bpm', ffmpeg, sampleRate: 8000, args: ['-v', 'error', '-i', '/missing/音频文件.wav', '-f', 'f32le', 'pipe:1'] })).rejects.toThrow('MEDIA_ANALYSIS_DECODE_FAILED')
    await expect(run({ kind: 'bpm', ffmpeg, sampleRate: 8000,
      args: ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '1', '-f', 'f32le', 'pipe:1']
    })).resolves.toBeNull()
  })

  it('cancels an active decoder and rejects already-cancelled requests', async () => {
    const controller = new AbortController()
    const pending = run({ kind: 'peaks', ffmpeg, sampleRate: 44100, durationMs: 60_000,
      args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-f', 'f32le', 'pipe:1']
    }, controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow('JOB_CANCELLED')
    await expect(run({ kind: 'bpm', ffmpeg, sampleRate: 8000, args: [] }, controller.signal)).rejects.toThrow('JOB_CANCELLED')
  })

  it('drains active and queued decoders on application shutdown', async () => {
    const runner = createMediaAnalysisRunner(await testAnalysisWorker())
    const tasks = Array.from({ length: 3 }, () => runner({ kind: 'peaks', ffmpeg, sampleRate: 44100, durationMs: 60_000,
      args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-f', 'f32le', 'pipe:1']
    }))
    const settled = Promise.allSettled(tasks)
    await new Promise(resolve => setTimeout(resolve, 100))
    await runner.shutdown()
    expect((await settled).every(result => result.status === 'rejected')).toBe(true)
    await expect(runner({ kind: 'bpm', ffmpeg, sampleRate: 8000, args: [] })).rejects.toThrow('JOB_CANCELLED')
  })
})
