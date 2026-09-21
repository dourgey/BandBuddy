import { z } from 'zod'

export const EFFECT_BLOCKS = ['drive', 'amp', 'eq', 'mod', 'delay', 'reverb'] as const
export const CLASSIC_AMPS = [
  { id: 'ab763-pre', name: 'AB763 · 美式清音前级', description: '两级 12AX7、前置 FMV 音调网络；不含功放、变压器和弹簧混响。' },
  { id: '2203-pre', name: '2203 · 英式过载前级', description: '三级 12AX7、10kΩ 无旁路冷削波级、后置 FMV；阴极跟随器作理想缓冲近似。' }
] as const
export const CLASSIC_CABS = [
  { id: 'open112', name: 'C12N · 1×12 开背', description: '单扬声器机电系统 + 开背偶极近似。' },
  { id: 'open212', name: 'C12N · 2×12 开背', description: '两只同相扬声器；未建模离轴梳状干涉。' },
  { id: 'sealed412', name: 'C12N · 4×12 密闭', description: '四只扬声器与共用密闭空气弹簧，箱内容积改变共振。' }
] as const
export const CLASSIC_MODS = [
  { id: 'phase90', name: 'Phase 90 · 移相电路', description: '四级 47nF 全通网络、三角 LFO；JFET 电阻曲线为降阶近似。' },
  { id: 'optical-tremolo', name: '光耦 Tremolo · 电路原型', description: 'LDR 分压器与光敏电阻不同的点亮、恢复时间。' },
  { id: 'chorus', name: 'BBD Chorus · 结构近似', description: '三角 LFO、可变延迟、前后低通；未逐级模拟 BBD 时钟和电荷转移。' },
  { id: 'flanger', name: 'BBD Flanger · 结构近似', description: '短延迟调制与反馈；并非某台量产设备的完整电路模型。' },
  { id: 'wah', name: 'RLC Wah · 电路原型', description: '电感谐振器的 TPT 状态空间实现，位置改变谐振频率。' },
  { id: 'ota-compressor', name: 'OTA Compressor · 结构近似', description: '整流 RC 检波与 OTA 差分对；尚未复现 Dyna Comp 完整反馈电路。' }
] as const
const unit = z.number().finite().min(0).max(1)
export const classicAmpSchema = z.object({
  device: z.enum(['ab763-pre', '2203-pre']).default('ab763-pre'),
  gain: unit.default(.35), bass: unit.default(.5), middle: unit.default(.5), treble: unit.default(.5), master: unit.default(.5),
  inputVolts: z.number().finite().min(.1).max(10).default(1)
})
export const classicCabSchema = z.object({
  device: z.enum(['open112', 'open212', 'sealed412']).default('open112'),
  volumeLitres: z.number().finite().min(10).max(300).default(80),
  distanceMetres: z.number().finite().min(.25).max(3).default(1),
  micAngle: z.number().finite().min(0).max(75).default(0)
})
export const modulationSchema = z.object({
  enabled: z.boolean().default(false), device: z.enum(['phase90', 'optical-tremolo', 'chorus', 'flanger', 'wah', 'ota-compressor']).default('phase90'),
  rateHz: z.number().finite().min(.05).max(10).default(.7), depth: unit.default(.6), mix: unit.default(.5),
  feedback: z.number().finite().min(0).max(.85).default(.3), manual: unit.default(.5)
})
export type ModulationSettings = z.infer<typeof modulationSchema>
export const WHITEBOX_DEVICES = [
  { id: 'ts808', name: 'TS808 · 反馈过载', description: '对称反馈削波，Drive 调整反馈电阻；适合放在 NAM 前推动箱头。' },
  { id: 'sd1', name: 'SD-1 · 不对称过载', description: '1:2 二极管反馈削波，独立增益范围、线性 Drive 和音调网络。' },
  { id: 'rat', name: 'RAT · 对地失真', description: '双 RC 增益支路、有限带宽和转换速率；Filter 越大越暗。' },
  { id: 'microamp', name: 'Micro Amp · 干净提升', description: '56kΩ 反馈、2.7kΩ + 500kΩ 增益支路；软件电平是额外输出微调。' },
  { id: 'fuzzface', name: 'Fuzz Face · 硅管电路', description: '双晶体管 Ebers–Moll、全局反馈与发射极旁路；固定10kΩ源阻抗，不恢复真实拾音器负载。' },
  { id: 'distortion-plus', name: 'Distortion+ · 锗削波', description: '1MΩ 反馈、可变增益支路与独立锗二极管对地削波；原机没有 Tone 旋钮。' }
] as const
export const whiteboxSchema = z.object({
  enabled: z.boolean(), device: z.enum(['ts808', 'sd1', 'rat', 'microamp', 'distortion-plus', 'fuzzface']), revision: z.literal(1),
  drive: z.number().finite().min(0).max(1), tone: z.number().finite().min(0).max(1),
  level: z.number().finite().min(0).max(1),
  inputVolts: z.number().finite().min(.1).max(10),
  oversampling: z.union([z.literal(2), z.literal(4)])
})
export type WhiteboxSettings = z.infer<typeof whiteboxSchema>
export function defaultWhitebox(): WhiteboxSettings {
  return { enabled: false, device: 'ts808', revision: 1, drive: .4, tone: .5, level: .7, inputVolts: 1, oversampling: 4 }
}
export type EffectBlock = typeof EFFECT_BLOCKS[number]
export type MonitorMode = 'off' | 'dry' | 'wet'
const db = z.number().finite().min(-60).max(24)
const asset = z.string().regex(/^[a-f0-9]{64}$/).nullable()
export const effectChainSchema = z.object({
  version: z.literal(1),
  order: z.array(z.enum(EFFECT_BLOCKS)).refine(v =>
    new Set(v).size === v.length && ['amp', 'eq', 'delay', 'reverb'].every(b => v.includes(b as typeof v[number]))
  ).transform(v => { const order = v.includes('drive') ? [...v] : ['drive' as const, ...v]; if (!order.includes('mod')) order.splice(order.indexOf('delay'), 0, 'mod'); return order }),
  drive: whiteboxSchema.default(defaultWhitebox),
  mod: modulationSchema.default(() => modulationSchema.parse({})),
  inputGainDb: db, outputGainDb: db,
  amp: z.object({ enabled: z.boolean(), assetId: asset, quality: z.enum(['full', 'lite']), engine: z.enum(['nam', 'classic']).default('nam'), classic: classicAmpSchema.default(() => classicAmpSchema.parse({})) }),
  cab: z.object({ enabled: z.boolean(), assetId: asset, gainDb: db, lowCut: z.number().min(20).max(500), highCut: z.number().min(1000).max(20000), engine: z.enum(['ir', 'physical']).default('ir'), physical: classicCabSchema.default(() => classicCabSchema.parse({})) }),
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
    drive: defaultWhitebox(), mod: modulationSchema.parse({}),
    amp: { enabled: false, assetId: null, quality: 'full', engine: 'nam', classic: classicAmpSchema.parse({}) },
    cab: { enabled: false, assetId: null, gainDb: 0, lowCut: 20, highCut: 20000, engine: 'ir', physical: classicCabSchema.parse({}) },
    eq: { enabled: false, bands: [0,0,0,0,0,0,0], gainDb: 0 },
    delay: { enabled: false, timeMs: 350, feedback: .3, mix: .2, tone: 6000, sync: false, division: '1/4', bpm: 120 },
    reverb: { enabled: false, decay: 2.5, preDelayMs: 20, damping: .5, mix: .2 } }
}
export function effectStructureKey(chain: EffectChainSnapshot): string {
  return JSON.stringify([chain.order, chain.amp.assetId, chain.amp.quality, chain.cab.assetId, chain.drive?.device, chain.drive?.revision, chain.drive?.oversampling, chain.amp.engine, chain.amp.classic.device, chain.cab.engine, chain.cab.physical.device, chain.mod.device])
}
export const ARSENAL_CHANNEL = 'arsenal:request'
export const ARSENAL_MONITOR_EVENT = 'arsenal:monitor'
