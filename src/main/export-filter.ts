import { dbToGain, type TrackState } from '@shared/domain.js'

export interface MixFilterOptions {
  tracks: Array<{ inputIndex: number; state: TrackState }>
  takes?: Array<{
    inputIndex: number
    gainDb: number
    startPositionMs: number
    playbackRate: number
    alignmentOffsetMs: number
  }>
  masterGainDb: number
  playbackRate: number | null
  loopStartMs: number | null
  loopEndMs: number | null
  sourceDurationMs?: number
}

export function buildAtempoChain(playbackRate: number): string[] {
  const factors: number[] = []
  let remaining = playbackRate
  while (remaining < 0.5) {
    factors.push(0.5)
    remaining /= 0.5
  }
  while (remaining > 2) {
    factors.push(2)
    remaining /= 2
  }
  if (Math.abs(remaining - 1) > 0.0001 || factors.length === 0) factors.push(remaining)
  return factors.map((factor) => `atempo=${factor.toFixed(4)}`)
}

export function buildMixFilter(options: MixFilterOptions): string {
  if (options.tracks.length === 0 && !options.takes?.length) throw new Error('NO_AUDIBLE_TRACKS')
  const outputs: string[] = []
  const filters: string[] = []
  for (const { inputIndex, state } of options.tracks) {
    const chain: string[] = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (options.loopStartMs !== null && options.loopEndMs !== null) {
      chain.push(`atrim=start=${(options.loopStartMs / 1000).toFixed(3)}:end=${(options.loopEndMs / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS')
    }
    chain.push(`volume=${dbToGain(state.gainDb).toFixed(8)}`)
    if (options.playbackRate !== null && Math.abs(options.playbackRate - 1) > 0.0001) chain.push(...buildAtempoChain(options.playbackRate))
    const label = `t${inputIndex}`
    filters.push(`[${inputIndex}:a]${chain.join(',')}[${label}]`)
    outputs.push(`[${label}]`)
  }
  for (const [index, take] of (options.takes ?? []).entries()) {
    const rangeStartMs = options.loopStartMs ?? 0
    const relativeDelayMs = take.startPositionMs / take.playbackRate + take.alignmentOffsetMs - rangeStartMs / take.playbackRate
    const chain = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (relativeDelayMs < 0) chain.push(`atrim=start=${(-relativeDelayMs / 1000).toFixed(6)}`, 'asetpts=PTS-STARTPTS')
    else if (relativeDelayMs > 0) chain.push(`adelay=${Math.round(relativeDelayMs)}:all=1`)
    chain.push(`volume=${dbToGain(take.gainDb).toFixed(8)}`)
    const label = `recording${index}`
    filters.push(`[${take.inputIndex}:a]${chain.join(',')}[${label}]`)
    outputs.push(`[${label}]`)
  }
  filters.push(`${outputs.join('')}amix=inputs=${outputs.length}:duration=longest:normalize=0[mixed]`)
  const final: string[] = [`volume=${dbToGain(options.masterGainDb).toFixed(8)}`]
  if (options.sourceDurationMs && options.playbackRate) {
    const durationMs = options.loopStartMs !== null && options.loopEndMs !== null
      ? options.loopEndMs - options.loopStartMs
      : options.sourceDurationMs
    final.push(`atrim=end=${(durationMs / options.playbackRate / 1000).toFixed(6)}`, 'asetpts=PTS-STARTPTS')
  }
  final.push('alimiter=limit=0.98:level=disabled')
  filters.push(`[mixed]${final.join(',')}[out]`)
  return filters.join(';')
}
