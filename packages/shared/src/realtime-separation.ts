import { z } from 'zod'

export const REALTIME_CHANNEL = 'realtime-separation:command'
export const REALTIME_EVENT = 'realtime-separation:changed'
export const REALTIME_STEMS = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'] as const
export const realtimeMixSchema = z.object({
  stems: z.array(z.enum(REALTIME_STEMS)).min(1).max(6).refine(values => new Set(values).size === values.length),
  mode: z.enum(['remove', 'solo'])
})
export const realtimeConfigSchema = realtimeMixSchema.extend({
  source: z.string().max(1024), output: z.string().max(1024),
  rate: z.union([z.literal(44100), z.literal(48000)]),
  profile: z.enum(['smooth', 'lowLatency']), backend: z.enum(['auto', 'cpu', 'cuda', 'mps'])
})
export type RealtimeConfig = z.infer<typeof realtimeConfigSchema>
export type RealtimeMix = z.infer<typeof realtimeMixSchema>
export interface RealtimeDevice { id: string; name: string; input: boolean; output: boolean; kind: 'loopback' | 'tap' | 'device'; rate?: number }
export const realtimeMetricsSchema = z.object({
  passed: z.boolean(), p99Ms: z.number().finite().nonnegative(), maxMs: z.number().finite().nonnegative(),
  latencyMs: z.number().finite().nonnegative(), signalVerified: z.boolean(),
  inputDrops: z.number().int().nonnegative(), underruns: z.number().int().nonnegative(),
  overflows: z.number().int().nonnegative(), clockErrors: z.number().int().nonnegative()
})
export type RealtimeMetrics = z.infer<typeof realtimeMetricsSchema>
export interface RealtimeState {
  phase: 'idle' | 'waiting' | 'warming' | 'testing' | 'starting' | 'running' | 'stopping' | 'failed'
  config: RealtimeConfig; eligible: boolean; message: string; progress: number
  metrics: RealtimeMetrics | null
  lastTest: { at: string; config: RealtimeConfig; metrics: RealtimeMetrics } | null
}
export interface RealtimeCapabilities { supported: boolean; platform: string; ready: boolean; device: string; devices: RealtimeDevice[]; error?: string }
export interface RealtimeSeparationApi {
  capabilities(): Promise<RealtimeCapabilities>
  state(): Promise<RealtimeState>
  configure(config: RealtimeConfig): Promise<RealtimeState>
  test(): Promise<RealtimeState>
  stop(): Promise<RealtimeState>
  start(): Promise<RealtimeState>
  mix(input: RealtimeMix): Promise<RealtimeState>
  openSetup(target: 'routing' | 'driver' | 'permission' | 'macDriver'): Promise<void>
  onChanged(callback: (state: RealtimeState) => void): () => void
}
export const DEFAULT_REALTIME_CONFIG: RealtimeConfig = { source: '', output: '', rate: 48000, profile: 'smooth', backend: 'auto', stems: ['drums'], mode: 'remove' }

export function realtimePassed(config: RealtimeConfig, metrics: RealtimeMetrics): boolean {
  const hop = config.profile === 'smooth' ? 120 : 60
  const limit = config.profile === 'smooth' ? 1000 : 300
  return metrics.passed && metrics.signalVerified && metrics.p99Ms <= hop * .8 && metrics.maxMs <= hop
    && metrics.latencyMs > 0 && metrics.latencyMs <= limit
    && metrics.inputDrops === 0 && metrics.underruns === 0 && metrics.overflows === 0 && metrics.clockErrors === 0
}
