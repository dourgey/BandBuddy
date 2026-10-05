import { z } from 'zod'

export const EFFECT_BLOCKS = ['dynamic', 'drive', 'amp', 'cab', 'eq', 'mod', 'delay', 'reverb'] as const
export const CLASSIC_AMPS = [
  { id: 'orange', name: 'Orange 风格 · 英式厚声', description: '高通耦合、四级三极管和后置音调网络的结构近似。' },
  { id: 'mesa', name: 'MESA 风格 · 高增益', description: '级间低频收紧、多级饱和与后置音调网络的结构近似。' },
  { id: 'vox', name: 'VOX 风格 · 清亮', description: '两级增益、较小阴极旁路电容和明亮音调的结构近似。' },
  { id: 'ab763-pre', name: 'AB763 · 美式清音前级', description: '两级 12AX7、前置 FMV 音调网络；不含功放、变压器和弹簧混响。' },
  { id: '2203-pre', name: '2203 · 英式过载前级', description: '三级 12AX7、10kΩ 无旁路冷削波级、后置 FMV；阴极跟随器作理想缓冲近似。' }
] as const
export const CLASSIC_CABS = [
  { id: 'open112', name: 'C12N · 1×12 开背', description: '单扬声器机电系统 + 开背偶极近似。' },
  { id: 'open212', name: 'C12N · 2×12 开背', description: '两只同相扬声器；未建模离轴梳状干涉。' },
  { id: 'sealed412', name: 'C12N · 4×12 密闭', description: '四只扬声器与共用密闭空气弹簧，箱内容积改变共振。' }
] as const
export const CLASSIC_MODS = [
  { id: 'vibrato', name: 'Vibrato', description: '仅输出调制延迟的湿声，形成周期性音高变化。' },
  { id: 'phase90', name: 'Phase 90 · 移相电路', description: '四级 47nF 全通网络、三角 LFO；JFET 电阻曲线为降阶近似。' },
  { id: 'optical-tremolo', name: '光耦 Tremolo · 电路原型', description: 'LDR 分压器与光敏电阻不同的点亮、恢复时间。' },
  { id: 'chorus', name: 'BBD Chorus · 结构近似', description: '三角 LFO、可变延迟、前后低通；未逐级模拟 BBD 时钟和电荷转移。' },
  { id: 'flanger', name: 'BBD Flanger · 结构近似', description: '短延迟调制与反馈；并非某台量产设备的完整电路模型。' },
  { id: 'wah', name: 'RLC Wah · 电路原型', description: '电感谐振器的 TPT 状态空间实现，位置改变谐振频率。' },
  { id: 'ota-compressor', name: 'OTA Compressor · 结构近似', description: '整流 RC 检波与 OTA 差分对；尚未复现 Dyna Comp 完整反馈电路。' }
] as const
const unit = z.number().finite().min(0).max(1)
export const classicAmpSchema = z.object({
  device: z.enum(['ab763-pre', '2203-pre', 'orange', 'mesa', 'vox']).default('ab763-pre'),
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
  enabled: z.boolean().default(false), device: z.enum(['phase90', 'optical-tremolo', 'chorus', 'flanger', 'wah', 'ota-compressor', 'vibrato']).default('phase90'),
  rateHz: z.number().finite().min(.05).max(10).default(.7), depth: unit.default(.6), mix: unit.default(.5),
  feedback: z.number().finite().min(0).max(.85).default(.3), manual: unit.default(.5)
})
export type ModulationSettings = z.infer<typeof modulationSchema>
export const WHITEBOX_DEVICES = [
  { id: 'ds1', name: 'BOSS DS-1 风格', description: '晶体管增益、运放放大、二极管对地削波和中频凹陷音调网络。' },
  { id: 'bd2', name: 'BOSS BD-2 风格', description: '两级不对称宽带饱和与被动音调的结构近似。' },
  { id: 'ts808', name: 'TS808 · 反馈过载', description: '对称反馈削波，Drive 调整反馈电阻；适合放在 NAM 前推动箱头。' },
  { id: 'sd1', name: 'SD-1 · 不对称过载', description: '1:2 二极管反馈削波，独立增益范围、线性 Drive 和音调网络。' },
  { id: 'rat', name: 'RAT · 对地失真', description: '双 RC 增益支路、有限带宽和转换速率；Filter 越大越暗。' },
  { id: 'microamp', name: 'Micro Amp · 干净提升', description: '56kΩ 反馈、2.7kΩ + 500kΩ 增益支路；软件电平是额外输出微调。' },
  { id: 'fuzzface', name: 'Fuzz Face · 硅管电路', description: '双晶体管 Ebers–Moll、全局反馈与发射极旁路；固定10kΩ源阻抗，不恢复真实拾音器负载。' },
  { id: 'distortion-plus', name: 'Distortion+ · 锗削波', description: '1MΩ 反馈、可变增益支路与独立锗二极管对地削波；原机没有 Tone 旋钮。' }
] as const
export const whiteboxSchema = z.object({
  enabled: z.boolean(), device: z.enum(['ts808', 'sd1', 'rat', 'microamp', 'distortion-plus', 'fuzzface', 'ds1', 'bd2']), revision: z.literal(1),
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
const legacyChainSchema = z.object({
  version: z.literal(1),
  dspRevision: z.union([z.literal(1), z.literal(2)]).default(1),
  order: z.array(z.enum(EFFECT_BLOCKS)).max(24).refine(order => new Set(order).size === order.length, '重复模块请使用独立模块 ID').transform(order => {
    // Single-module prepared chains intentionally contain one block.
    if (order.length <= 1) return order
    const next = [...order]
    if (!next.includes('drive')) next.unshift('drive')
    if (!next.includes('mod')) next.splice(next.indexOf('amp') >= 0 ? next.indexOf('amp') + 1 : 1, 0, 'mod')
    return next
  }),
  dynamic: z.object({ enabled: z.boolean().default(false), device: z.enum(['compressor', 'boost', 'gate']).default('compressor'), threshold: z.number().min(-80).max(0).default(-24), ratio: z.number().min(1).max(20).default(4), attack: z.number().min(.1).max(100).default(10), release: z.number().min(10).max(1000).default(120), gainDb: db.default(0), knee: z.number().min(0).max(24).default(6), mix: unit.default(1), stereoLink: z.boolean().default(true), hysteresis: z.number().min(0).max(24).default(6), holdMs: z.number().min(0).max(500).default(50) }).default(() => ({ enabled: false, device: 'compressor' as const, threshold: -24, ratio: 4, attack: 10, release: 120, gainDb: 0, knee: 6, mix: 1, stereoLink: true, hysteresis: 6, holdMs: 50 })),
  drive: whiteboxSchema.default(defaultWhitebox),
  mod: modulationSchema.default(() => modulationSchema.parse({})),
  inputGainDb: db, outputGainDb: db,
  amp: z.object({ enabled: z.boolean(), assetId: asset, quality: z.enum(['full', 'lite']), engine: z.enum(['nam', 'classic']).default('nam'), classic: classicAmpSchema.default(() => classicAmpSchema.parse({})), trimDb: db.default(0), levelDb: db.default(0), calibration: z.boolean().default(false), inputDbU: z.number().min(-30).max(40).nullable().default(null), outputDbU: z.number().min(-30).max(40).nullable().default(null), outputMode: z.enum(['raw', 'calibrated', 'normalized']).default('raw') }),
  cab: z.object({ enabled: z.boolean(), assetId: asset, gainDb: db, lowCut: z.number().min(20).max(500), highCut: z.number().min(1000).max(20000), engine: z.enum(['ir', 'physical']).default('ir'), physical: classicCabSchema.default(() => classicCabSchema.parse({})), secondaryAssetId: asset.default(null), blend: unit.default(.5), secondaryGainDb: db.default(0), secondaryPolarity: z.boolean().default(false), secondaryDelayMs: z.number().min(0).max(20).default(0), pan: z.number().min(-1).max(1).default(0), secondaryPan: z.number().min(-1).max(1).default(0) }),
  eq: z.object({ bandCount: z.union([z.literal(5), z.literal(7)]).default(7), enabled: z.boolean(), bands: z.array(z.number().min(-15).max(15)).length(7), gainDb: db, mode: z.enum(['graphic', 'parametric']).default('graphic'), lowCut: z.number().min(20).max(1000).default(20), highCut: z.number().min(1000).max(20000).default(20000), parametric: z.array(z.object({ frequency: z.number().min(20).max(20000), gain: z.number().min(-18).max(18), q: z.number().min(.1).max(12) })).length(4).default(() => [100, 400, 1600, 6400].map(frequency => ({ frequency, gain: 0, q: .707 }))) }),
  delay: z.object({ style: z.enum(['digital', 'analog', 'tape', 'reverse', 'pingpong']).default('digital'), enabled: z.boolean(), timeMs: z.number().min(1).max(2000), feedback: z.number().min(0).max(.95), mix: z.number().min(0).max(1), tone: z.number().min(200).max(16000), sync: z.boolean(), division: z.enum(['1/4', '1/8', '1/8d', '1/16']), bpm: z.number().min(20).max(400) }),
  reverb: z.object({ style: z.enum(['room', 'hall', 'plate', 'spring']).default('hall'), enabled: z.boolean(), decay: z.number().min(.1).max(10), preDelayMs: z.number().min(0).max(200), damping: z.number().min(0).max(1), mix: z.number().min(0).max(1) })
})
export const effectModuleSchema = z.object({ id: z.string().min(1).max(80), type: z.enum(EFFECT_BLOCKS), settings: legacyChainSchema })
export type EffectModule = z.infer<typeof effectModuleSchema>
const runtimeChainSchema = legacyChainSchema.extend({ modules: z.array(effectModuleSchema).max(24).refine(modules => new Set(modules.map(m => m.id)).size === modules.length, '模块 ID 不可重复').optional() })
export type EffectChainSnapshot = z.infer<typeof runtimeChainSchema>
const storedModuleSchema = z.object({ id: z.string().min(1).max(80), type: z.enum(EFFECT_BLOCKS), revision: z.union([z.literal(1), z.literal(2)]), params: z.unknown() })
export const storedChainSchema = z.object({ version: z.literal(2), inputGainDb: db, outputGainDb: db, modules: z.array(storedModuleSchema).max(24) })
export type StoredEffectChain = z.infer<typeof storedChainSchema>
/** Version 1 is an adapter for the existing native ABI; persisted V2 modules are compact. */
export const effectChainSchema = z.preprocess((input, ctx): unknown => {
  if (!input || typeof input !== 'object' || (input as { version?: number }).version !== 2) return input
  try {
  const stored = storedChainSchema.parse(input)
  const chain = defaultEffectChain()
  return { ...chain, inputGainDb: stored.inputGainDb, outputGainDb: stored.outputGainDb, modules: stored.modules.map(m => ({ id: m.id, type: m.type, settings: legacyChainSchema.parse({ ...defaultEffectChain(), dspRevision: m.revision, [m.type]: legacyChainSchema.shape[m.type].parse(m.params) }) })) }
  } catch { ctx.addIssue({ code: 'custom', message: '无效的 v2 效果链' }); return z.NEVER }
}, runtimeChainSchema)
export function storeEffectChain(input: EffectChainSnapshot): StoredEffectChain {
  const chain = effectChainSchema.parse(input)
  return { version: 2, inputGainDb: chain.inputGainDb, outputGainDb: chain.outputGainDb, modules: chainModules(chain).map(m => ({ id: m.id, type: m.type, revision: m.settings.dspRevision, params: m.settings[m.type] })) }
}
export function chainModules(chain: EffectChainSnapshot): EffectModule[] {
  if (chain.modules) return chain.modules
  const order = [...chain.order]
  if (!order.includes('cab')) order.splice(order.indexOf('amp') + 1, 0, 'cab')
  return order.map((type, i) => ({ id: `legacy-${type}-${i}`, type, settings: legacyChainSchema.parse(chain) }))
}
export function moduleChain(module: EffectModule): EffectChainSnapshot {
  const chain = legacyChainSchema.parse(module.settings)
  chain.order = [module.type]; chain.inputGainDb = 0; chain.outputGainDb = 0
  for (const type of EFFECT_BLOCKS) if (type !== module.type) chain[type].enabled = false
  return chain
}
export function createEffectModule(type: EffectBlock): EffectModule {
  const settings = legacyChainSchema.parse(defaultEffectChain())
  settings.dspRevision = 2
  settings[type].enabled = true
  if (type === 'amp') settings.amp.engine = 'classic'
  if (type === 'cab') settings.cab.engine = 'physical'
  return { id: crypto.randomUUID(), type, settings }
}
export interface ToneAsset { id: string; kind: 'nam' | 'ir'; name: string; sampleRate: number; channels: number; durationMs: number; architecture?: string; slimmable?: boolean; metadata: Record<string, unknown>; createdAt: string; tags?: string[]; favorite?: boolean; role?: 'amp' | 'pedal' | 'rig' | 'unknown'; notes?: string }
export interface ArsenalPreset { id: string; name: string; chain: EffectChainSnapshot; revision: number; createdAt: string; updatedAt: string; tags?: string[]; favorite?: boolean; factory?: boolean }
export interface TrackEffects { enabled: boolean; presetId: string | null; chain: EffectChainSnapshot; monitorMode: MonitorMode }
export const trackEffectsSchema = z.object({ enabled: z.boolean(), presetId: z.string().uuid().nullable(), chain: effectChainSchema, monitorMode: z.enum(['off', 'dry', 'wet']) })
export interface ArsenalTake { id: string; name: string; createdAt: string; durationMs: number; sampleRate: number; channels: number; chain: EffectChainSnapshot; recovered?: boolean }
export interface ArsenalDraft { name: string; presetId?: string; chain: EffectChainSnapshot; selected?: string; dirty: boolean }
export interface ArsenalWorkspace { favorites?: string[]; draft: ArsenalDraft | null; takes: ArsenalTake[]; quick: { recording: boolean; looping: boolean; durationMs: number }; }
export type ArsenalCommand = {action:'favorite';id:string;value:boolean} | { action: 'tuner'; enabled: boolean } | { action: 'workspace' | 'stopRecord' | 'stopLoop' } | { action: 'draft'; draft: ArsenalDraft } | { action: 'record'; name: string; chain: EffectChainSnapshot } | { action: 'loop'; id: string; startMs: number; endMs: number } | { action: 'exportTake'; id: string; wet: boolean; chain?: EffectChainSnapshot } | { action: 'deleteTake'; id: string } | { action: 'exportPreset'; preset: ArsenalPreset } | { action: 'importPreset' } | { action: 'asset'; id: string; name: string; tags: string[]; role: 'amp' | 'pedal' | 'rig' | 'unknown'; favorite: boolean; notes: string }
export interface ArsenalState { presets: ArsenalPreset[]; assets: ToneAsset[] }
export interface ArsenalMonitorState { active: boolean; mode: MonitorMode; sampleRate: number; bufferFrames: number; latencyMs: number; peak: number[]; outputPeak: number; xruns: number; error: string | null; tunerActive?: boolean; tunerHz?: number; dspLoad?: number; dspLatencyMs?: number }
export interface PreparedEffects { modules?: PreparedEffects[]; chain: EffectChainSnapshot; model: string | null; modelRate: number; ir: number[][] | null; irRate: number; secondaryIr?: number[][] | null; secondaryIrRate?: number; namInputGain?: number; namOutputGain?: number }
export interface ArsenalApi {
  feed(input:{bus:number;sampleRate:number;samples:number[];reset?:boolean}):Promise<boolean>
  list(): Promise<ArsenalState>
  command(input: ArsenalCommand): Promise<ArsenalWorkspace>
  importAsset(kind: 'nam' | 'ir', sampleRate?: number): Promise<ToneAsset | null>
  deleteAsset(id: string): Promise<void>
  savePreset(input: { id?: string; name: string; chain: EffectChainSnapshot; tags?: string[]; favorite?: boolean }): Promise<ArsenalPreset>
  deletePreset(id: string): Promise<void>
  setTrack(input: { trackId: string; effects: TrackEffects }): Promise<void>
  prepare(chain: EffectChainSnapshot): Promise<PreparedEffects>
  monitor(input: { mode: MonitorMode; chain: EffectChainSnapshot }): Promise<ArsenalMonitorState>
  monitorState(): Promise<ArsenalMonitorState>
  onMonitor(callback: (state: ArsenalMonitorState) => void): () => void
}
export function defaultEffectChain(): EffectChainSnapshot {
  return legacyChainSchema.parse({ version: 1, order: [...EFFECT_BLOCKS], inputGainDb: 0, outputGainDb: -6,
    drive: defaultWhitebox(), mod: modulationSchema.parse({}),
    amp: { enabled: false, assetId: null, quality: 'full', engine: 'nam', classic: classicAmpSchema.parse({}) },
    cab: { enabled: false, assetId: null, gainDb: 0, lowCut: 20, highCut: 20000, engine: 'ir', physical: classicCabSchema.parse({}) },
    eq: { enabled: false, bands: [0,0,0,0,0,0,0], gainDb: 0 },
    delay: { enabled: false, timeMs: 350, feedback: .3, mix: .2, tone: 6000, sync: false, division: '1/4', bpm: 120 },
    reverb: { enabled: false, decay: 2.5, preDelayMs: 20, damping: .5, mix: .2 } })
}
export function effectStructureKey(chain: EffectChainSnapshot): string {
  if (chain.modules) return JSON.stringify(chain.modules.map(m => [m.id, m.type, effectStructureKey(moduleChain(m))]))
  return JSON.stringify([chain.order, chain.dspRevision, chain.amp.assetId, chain.amp.quality, chain.amp.calibration, chain.amp.inputDbU, chain.amp.outputDbU, chain.amp.outputMode, chain.cab.assetId, chain.cab.secondaryAssetId, chain.drive?.device, chain.drive?.revision, chain.drive?.oversampling, chain.amp.engine, chain.amp.classic.device, chain.cab.engine, chain.cab.physical.device, chain.mod.device])
}
export const ARSENAL_CHANNEL = 'arsenal:request'
export const ARSENAL_MONITOR_EVENT = 'arsenal:monitor'
