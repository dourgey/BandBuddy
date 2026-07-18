import { dbToGain, type TrackState } from '@shared/domain.js'

export interface MixFilterOptions {
  tracks: Array<{ inputIndex: number; state: TrackState }>
  masterGainDb: number
  playbackRate: number | null
  loopStartMs: number | null
  loopEndMs: number | null
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
  if (options.tracks.length === 0) throw new Error('NO_AUDIBLE_TRACKS')
  const outputs: string[] = []
  const filters: string[] = []
  for (const { inputIndex, state } of options.tracks) {
    const chain: string[] = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (options.loopStartMs !== null && options.loopEndMs !== null) {
      chain.push(`atrim=start=${(options.loopStartMs / 1000).toFixed(3)}:end=${(options.loopEndMs / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS')
    }
    chain.push(`volume=${dbToGain(state.gainDb).toFixed(8)}`)
    const label = `t${inputIndex}`
    filters.push(`[${inputIndex}:a]${chain.join(',')}[${label}]`)
    outputs.push(`[${label}]`)
  }
  filters.push(`${outputs.join('')}amix=inputs=${outputs.length}:duration=longest:normalize=0[mixed]`)
  const final: string[] = [`volume=${dbToGain(options.masterGainDb).toFixed(8)}`]
  if (options.playbackRate !== null && Math.abs(options.playbackRate - 1) > 0.0001) final.push(...buildAtempoChain(options.playbackRate))
  final.push('alimiter=limit=0.98:level=disabled')
  filters.push(`[mixed]${final.join(',')}[out]`)
  return filters.join(';')
}
