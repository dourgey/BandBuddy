import { z } from 'zod'

export const EFFECT_BLOCKS = ['amp', 'eq', 'delay', 'reverb'] as const
export type EffectBlock = typeof EFFECT_BLOCKS[number]
export type MonitorMode = 'off' | 'dry' | 'wet'
const db = z.number().finite().min(-60).max(24)
const asset = z.string().regex(/^[a-f0-9]{64}$/).nullable()
export const effectChainSchema = z.object({
  version: z.literal(1),
  order: z.array(z.enum(EFFECT_BLOCKS)).length(4).refine(v => new Set(v).size === 4),
  inputGainDb: db, outputGainDb: db,
  amp: z.object({ enabled: z.boolean(), assetId: asset, quality: z.enum(['full', 'lite']) }),
  cab: z.object({ enabled: z.boolean(), assetId: asset, gainDb: db, lowCut: z.number().min(20).max(500), highCut: z.number().min(1000).max(20000) }),
  eq: z.object({ enabled: z.boolean(), bands: z.array(z.number().min(-15).max(15)).length(7), gainDb: db }),
  delay: z.object({ enabled: z.boolean(), timeMs: z.number().min(1).max(2000), feedback: z.number().min(0).max(.95), mix: z.number().min(0).max(1), tone: z.number().min(200).max(16000), sync: z.boolean(), division: z.enum(['1/4', '1/8', '1/8d', '1/16']), bpm: z.number().min(20).max(400) }),
  reverb: z.object({ enabled: z.boolean(), decay: z.number().min(.1).max(10), preDelayMs: z.number().min(0).max(200), damping: z.number().min(0).max(1), mix: z.number().min(0).max(1) })
})
export type EffectChainSnapshot = z.infer<typeof effectChainSchema>
export interface ToneAsset { id: string; kind: 'nam' | 'ir'; name: string; sampleRate: number; channels: number; durationMs: number; architecture?: string; slimmable?: boolean; metadata: Record<string, unknown>; createdAt: string }
export interface ArsenalPreset { id: string; name: string; chain: EffectChainSnapshot; revision: number; createdAt: string; updatedAt: string }
export interface TrackEffects { enabled: boolean; presetId: string | null; chain: EffectChainSnapshot; monitorMode: MonitorMode }
export const trackEffectsSchema = z.object({ enabled: z.boolean(), presetId: z.string().uuid().nullable(), chain: effectChainSchema, monitorMode: z.enum(['off', 'dry', 'wet']) })
export interface ArsenalState { presets: ArsenalPreset[]; assets: ToneAsset[] }
export interface ArsenalMonitorState { active: boolean; mode: MonitorMode; sampleRate: number; bufferFrames: number; latencyMs: number; peak: number[]; outputPeak: number; xruns: number; error: string | null }
export interface PreparedEffects { chain: EffectChainSnapshot; model: string | null; modelRate: number; ir: number[][] | null; irRate: number }
export interface ArsenalApi {
  list(): Promise<ArsenalState>
  importAsset(kind: 'nam' | 'ir', sampleRate?: number): Promise<ToneAsset | null>
  deleteAsset(id: string): Promise<void>
  savePreset(input: { id?: string; name: string; chain: EffectChainSnapshot }): Promise<ArsenalPreset>
  deletePreset(id: string): Promise<void>
  setTrack(input: { trackId: string; effects: TrackEffects }): Promise<void>
  prepare(chain: EffectChainSnapshot): Promise<PreparedEffects>
  monitor(input: { mode: MonitorMode; chain: EffectChainSnapshot }): Promise<ArsenalMonitorState>
  monitorState(): Promise<ArsenalMonitorState>
  onMonitor(callback: (state: ArsenalMonitorState) => void): () => void
}
export function defaultEffectChain(): EffectChainSnapshot {
  return { version: 1, order: [...EFFECT_BLOCKS], inputGainDb: 0, outputGainDb: -6,
    amp: { enabled: false, assetId: null, quality: 'full' },
    cab: { enabled: false, assetId: null, gainDb: 0, lowCut: 20, highCut: 20000 },
    eq: { enabled: false, bands: [0,0,0,0,0,0,0], gainDb: 0 },
    delay: { enabled: false, timeMs: 350, feedback: .3, mix: .2, tone: 6000, sync: false, division: '1/4', bpm: 120 },
    reverb: { enabled: false, decay: 2.5, preDelayMs: 20, damping: .5, mix: .2 } }
}
export function effectStructureKey(chain: EffectChainSnapshot): string {
  return JSON.stringify([chain.order, chain.amp.assetId, chain.amp.quality, chain.cab.assetId])
}
export const ARSENAL_CHANNEL = 'arsenal:request'
export const ARSENAL_MONITOR_EVENT = 'arsenal:monitor'
