import { existsSync } from 'node:fs'
import type { AppPaths } from './paths.js'
import { runProcess } from './process.js'
import { buildAtempoChain } from './export-filter.js'
import { dbToGain } from '@shared/domain.js'

export interface PitchStemInput {
  path: string
  gainDb: number
}

export async function runSignalsmithPitchShift(
  paths: AppPaths,
  inputPath: string,
  outputPath: string,
  semitones: number,
  signal?: globalThis.AbortSignal
): Promise<void> {
  if (!Number.isInteger(semitones) || semitones < -12 || semitones > 12) {
    throw new Error('PITCH_SEMITONES_OUT_OF_RANGE')
  }
  const executable = paths.audioHostExecutable()
  if (!existsSync(executable)) throw new Error(`AUDIO_HOST_MISSING:${executable}`)
  const result = await runProcess(executable, ['--pitch', inputPath, outputPath, String(semitones)], { signal })
  if (signal?.aborted) throw new Error('PITCH_SHIFT_CANCELLED')
  if (result.code !== 0) throw new Error(`SIGNALSMITH_PITCH_SHIFT_FAILED:${(result.stderr || result.stdout).slice(-800)}`)
}

export async function renderPitchedStemBus(options: {
  paths: AppPaths
  ffmpeg: string
  stems: PitchStemInput[]
  startPositionMs: number
  endPositionMs: number
  playbackRate: number
  sampleRate: number
  semitones: number
  unpitchedPath: string
  pitchedPath: string
  signal?: globalThis.AbortSignal
}): Promise<string | null> {
  if (!options.stems.length) return null
  const durationSeconds = Math.max(0.05,
    (options.endPositionMs - options.startPositionMs) / options.playbackRate / 1000)
  const tempo = Math.abs(options.playbackRate - 1) > 0.0001
    ? buildAtempoChain(options.playbackRate)
    : []
  const filters = options.stems.map((stem, index) => {
    const chain = [
      `atrim=start=${(options.startPositionMs / 1000).toFixed(6)}:end=${(options.endPositionMs / 1000).toFixed(6)}`,
      'asetpts=PTS-STARTPTS',
      `aresample=${options.sampleRate}`,
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `volume=${dbToGain(stem.gainDb).toFixed(8)}`,
      ...tempo
    ]
    return `[${index}:a]${chain.join(',')}[pitch${index}]`
  })
  const labels = options.stems.map((_, index) => `[pitch${index}]`).join('')
  filters.push(`${labels}amix=inputs=${options.stems.length}:duration=longest:normalize=0,atrim=end=${durationSeconds.toFixed(6)},asetpts=PTS-STARTPTS[out]`)
  const render = await runProcess(options.ffmpeg, [
    '-y', '-v', 'error', ...options.stems.flatMap((stem) => ['-i', stem.path]),
    '-filter_complex', filters.join(';'), '-map', '[out]', '-map_metadata', '-1', '-vn',
    '-c:a', 'pcm_f32le', '-ar', String(options.sampleRate), '-ac', '2', options.unpitchedPath
  ], { signal: options.signal })
  if (options.signal?.aborted) throw new Error('PITCH_SHIFT_CANCELLED')
  if (render.code !== 0) throw new Error(`PITCH_BUS_RENDER_FAILED:${render.stderr.slice(-800)}`)
  await runSignalsmithPitchShift(
    options.paths,
    options.unpitchedPath,
    options.pitchedPath,
    options.semitones,
    options.signal
  )
  return options.pitchedPath
}
