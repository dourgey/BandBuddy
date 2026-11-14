import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { availableParallelism } from 'node:os'
import { app } from 'electron'
import type { BpmAnalysis } from './bpm-detection.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'
import type { RuntimeManager } from './runtime.js'
import { artifactValid, type Artifact } from './artifact-download.js'
import { RuntimeNetwork } from './runtime-network.js'
import { processFailure, runProcess } from './process.js'

export interface BpmAudioInput { path: string; gain: number }

/** One inference at a time bounds CPU/GPU memory, including across songs. */
export class BeatThisService {
  private readonly network = new RuntimeNetwork()
  private readonly lifecycle = new AbortController()
  private active = false
  constructor(private readonly paths: AppPaths, private readonly database: BandBuddyDatabase, private readonly runtime: RuntimeManager) {}

  shutdown(): void { this.lifecycle.abort(); this.network.close() }

  async detect(ffmpeg: string, inputs: BpmAudioInput[]): Promise<BpmAnalysis> {
    if (this.active) throw new Error('BPM_DETECTION_BUSY')
    if (!inputs.length) throw new Error('BPM_DETECTION_NO_AUDIO')
    this.active = true
    let temporary: string | undefined
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(15 * 60_000)])
    try {
      signal.throwIfAborted()
      const python = this.runtime.pythonExecutable()
      if (!existsSync(python)) throw new Error('BPM_RUNTIME_MISSING:请先在设置中准备 AI 运行环境')
      const root = app.isPackaged ? this.paths.packagedResource('beat-this') : path.resolve('resources/beat-this')
      const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
        package: { filename: string; sha256: string }; model: Artifact
      }
      const wheel = path.join(root, manifest.package.filename)
      if (!await artifactValid(wheel, manifest.package)) throw new Error('BPM_PACKAGE_INVALID')
      const model = path.join(this.database.getSettings().modelRoot, 'beat-this', manifest.model.filename)
      if (!await artifactValid(model, manifest.model)) {
        await this.network.download(manifest.model, model, this.database.getSettings().network, signal)
      }
      await mkdir(this.paths.cacheRoot, { recursive: true })
      temporary = await mkdtemp(path.join(this.paths.cacheRoot, 'beat-this-'))
      const audio = path.join(temporary, 'mix.wav')
      // Decode through the application's verified FFmpeg, avoiding torchaudio
      // backend/version differences. Reconstruct the original mix at unity gain.
      const labels = inputs.map((input, i) => `[${i}:a:0]volume=${input.gain}[b${i}]`)
      const mix = inputs.map((_, i) => `[b${i}]`).join('')
      const filter = `${labels.join(';')};${mix}amix=inputs=${inputs.length}:duration=longest:normalize=0[out]`
      const decoded = await runProcess(ffmpeg, [
        '-y', '-v', 'error', ...inputs.flatMap(input => ['-i', input.path]),
        '-filter_complex', filter, '-map', '[out]', '-vn', '-t', '1801',
        '-ac', '1', '-ar', '22050', '-c:a', 'pcm_f32le', audio
      ], { signal, timeoutMs: 120_000, stage: 'beat-this-decode' })
      if (decoded.code !== 0 || decoded.termination !== 'exited') throw processFailure(decoded, 'BPM_DETECTION_DECODE_FAILED')
      const script = app.isPackaged ? this.paths.packagedResource('worker', 'beat_this_tempo.py') : path.resolve('python/worker/beat_this_tempo.py')
      // Honor the user's CPU/GPU preference. CPU remains usable without a fresh
      // environment inventory or an acceleration-specific dependency install.
      const selected = this.runtime.getInfo().selectedDevice
      const preferred = this.database.getSettings().preferredDevice
      const device = preferred === 'cpu' ? 'cpu' : selected
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
        BANDBUDDY_CPU_THREADS: String(Math.max(1, Math.min(8, availableParallelism() - 1))) }
      delete env.PYTHONHOME
      delete env.PYTHONPATH
      const result = await runProcess(python, [script, '--audio', audio, '--checkpoint', model, '--package', wheel, '--device', device],
        { env, signal, timeoutMs: 10 * 60_000, stage: 'beat-this-inference' })
      if (result.code !== 0 || result.termination !== 'exited') throw processFailure(result, 'BPM_MODEL_FAILED')
      const message = result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line) as { type?: string; analysis?: BpmAnalysis | null } } catch { return null }
      }).findLast(value => value?.type === 'result')
      if (!message || message.analysis === undefined) throw new Error('BPM_MODEL_INVALID_RESULT')
      const analysis = message.analysis
      if (!analysis) throw new Error('BPM_DETECTION_UNSTABLE')
      if (!Number.isFinite(analysis.bpm) || analysis.bpm < 30 || analysis.bpm > 300
        || !Number.isFinite(analysis.confidence) || analysis.confidence < 0 || analysis.confidence > 1
        || !Number.isFinite(analysis.beatOffsetMs) || Math.abs(analysis.beatOffsetMs) > 30_000 / analysis.bpm + 1) throw new Error('BPM_MODEL_INVALID_RESULT')
      return { bpm: analysis.bpm, confidence: analysis.confidence, beatOffsetMs: analysis.beatOffsetMs }
    } finally {
      this.active = false
      if (temporary) await rm(temporary, { recursive: true, force: true })
    }
  }
}
