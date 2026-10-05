import { CLASSIC_AMPS, CLASSIC_CABS, CLASSIC_MODS, WHITEBOX_DEVICES, createEffectModule, defaultEffectChain, effectModuleSchema, type ArsenalPreset, type EffectBlock, type EffectModule, type ToneAsset } from './arsenal.js'

export const EFFECT_LABELS: Record<EffectBlock, string> = { dynamic: '动态', drive: 'Drive', amp: 'AMP', cab: 'CAB', eq: 'EQ', mod: '调制', delay: 'Delay', reverb: 'Reverb' }
export interface ParameterDefinition { path: string; label: string; min: number; max: number; step: number; unit: string; scale: number; advanced?: boolean }
export interface ChoiceDefinition { path: string; label: string; options: { id: string; name: string }[]; numeric?: boolean; advanced?: boolean }
export interface EffectDefinition { name: string; description: string; parameters: ParameterDefinition[]; choices: ChoiceDefinition[] }
const p = (path: string, label: string, min = 0, max = 1, step = .01, unit = '', scale = max === 1 && min === 0 ? 10 : 1, advanced = false): ParameterDefinition => ({ path, label, min, max, step, unit, scale, advanced })
const choice = (path: string, label: string, options: readonly { id: string; name: string }[], advanced = false): ChoiceDefinition => ({ path, label, options: [...options], advanced })
const simple = (ids: string[], names = ids) => ids.map((id, i) => ({ id, name: names[i]! }))
const ampNames: Record<string, string> = { 'ab763-pre': '美式清音', '2203-pre': '英式过载', orange: '英式厚声', mesa: '美式高增益', vox: '英式清亮' }
export function parameterValue(module: EffectModule, path: string): unknown {
  return path.split('.').reduce((value, key) => (value as Record<string, unknown>)[key], module.settings as unknown)
}
export function changeModuleParameter(module: EffectModule, path: string, value: unknown): EffectModule {
  const next = structuredClone(module), keys = path.split('.')
  let target = next.settings as unknown as Record<string, unknown>
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
  target[keys.at(-1)!] = value
  return effectModuleSchema.parse(next)
}
export function effectDefinition(module: EffectModule, assets: ToneAsset[] = []): EffectDefinition {
  const s = module.settings, d: EffectDefinition = { name: EFFECT_LABELS[module.type], description: '', parameters: [], choices: [] }
  const assetsOf = (kind: ToneAsset['kind']) => [{ id: '', name: '选择已导入资源' }, ...assets.filter(a => a.kind === kind).map(a => ({ id: a.id, name: a.name }))]
  switch (module.type) {
    case 'dynamic': {
      d.choices.push(choice('dynamic.device', '动态类型', simple(['compressor', 'boost', 'gate'], ['Compressor 压缩', 'Clean Boost', 'Noise Gate'])))
      d.name = { compressor: 'Compressor', boost: 'Clean Boost', gate: 'Noise Gate' }[s.dynamic.device]
      d.description = { compressor: '控制动态，保留拨弦的起伏与延音。', boost: '干净提升电平，推动后级或补偿音量。', gate: '分离开关门限，保持音符尾部自然衰减。' }[s.dynamic.device]
      if (s.dynamic.device !== 'boost') d.parameters.push(p('dynamic.threshold', 'Threshold', -80, 0, .5, ' dB', 1), p('dynamic.attack', 'Attack', .1, 100, .1, ' ms'), p('dynamic.release', 'Release', 10, 1000, 5, ' ms'))
      if (s.dynamic.device === 'compressor') d.parameters.push(p('dynamic.ratio', 'Ratio', 1, 20, .1, ':1'), p('dynamic.knee', 'Knee', 0, 24, .5, ' dB'), p('dynamic.mix', 'Mix'))
      if (s.dynamic.device === 'gate') d.parameters.push(p('dynamic.hysteresis', 'Hysteresis', 0, 24, .5, ' dB'), p('dynamic.holdMs', 'Hold', 0, 500, 5, ' ms'))
      d.parameters.push(p('dynamic.gainDb', s.dynamic.device === 'boost' ? 'Boost' : 'Level', -60, 24, .5, ' dB', 1))
      break
    }
    case 'drive': {
      const model = WHITEBOX_DEVICES.find(x => x.id === s.drive.device)!
      d.name = model.name.split(' · ')[0]!.replace('BOSS ', '').replace(' 风格', '')
      d.description = model.description
      d.choices.push(choice('drive.device', '单块型号', WHITEBOX_DEVICES))
      d.parameters.push(p('drive.drive', s.drive.device === 'fuzzface' ? 'Fuzz' : s.drive.device === 'microamp' ? 'Boost' : 'Drive'))
      if (!['microamp', 'distortion-plus', 'fuzzface'].includes(s.drive.device)) d.parameters.push(p('drive.tone', s.drive.device === 'rat' ? 'Filter' : 'Tone'))
      d.parameters.push(p('drive.level', 'Level'), p('drive.inputVolts', '输入标定', .1, 10, .1, ' V/FS', 1, true))
      d.choices.push({ ...choice('drive.oversampling', '过采样', simple(['2', '4'], ['2× · 低负载', '4× · 推荐']), true), numeric: true })
      break
    }
    case 'amp': {
      d.choices.push(choice('amp.engine', '箱头引擎', simple(['classic', 'nam'], ['原生箱头', 'NAM 模型'])))
      if (s.amp.engine === 'classic') {
        d.name = ampNames[s.amp.classic.device]!
        d.description = CLASSIC_AMPS.find(x => x.id === s.amp.classic.device)!.description
        d.choices.push(choice('amp.classic.device', '箱头型号', CLASSIC_AMPS.map(a => ({ id: a.id, name: ampNames[a.id]! }))))
        for (const key of ['gain', 'bass', 'middle', 'treble', 'master']) d.parameters.push(p(`amp.classic.${key}`, key.toUpperCase()))
        d.parameters.push(p('amp.classic.inputVolts', '输入标定', .1, 10, .1, ' V/FS', 1, true))
      } else {
        const asset = assets.find(a => a.id === s.amp.assetId)
        d.name = asset?.name ?? 'NAM 模型'
        d.description = asset ? `${asset.sampleRate / 1000} kHz · ${asset.architecture ?? 'NAM'}${asset.role === 'rig' ? ' · 已含箱体' : ''}` : '导入自己的 NAM 文件，选择模型后即可演奏。'
        d.choices.push(choice('amp.assetId', 'NAM 音色', assetsOf('nam')))
        if (asset?.slimmable) d.choices.push(choice('amp.quality', '模型质量', simple(['full', 'lite'], ['Full', 'Lite'])))
        d.parameters.push(p('amp.trimDb', 'Input Trim', -60, 24, .5, ' dB', 1), p('amp.levelDb', 'Level', -60, 24, .5, ' dB', 1))
        d.choices.push(choice('amp.outputMode', '输出电平模式', simple(['raw', 'calibrated', 'normalized'], ['原始', '标定电平', '模型响度归一化']), true))
      }
      break
    }
    case 'cab': {
      d.choices.push(choice('cab.engine', '箱体引擎', simple(['physical', 'ir'], ['原生箱体', '脉冲响应 IR'])))
      if (s.cab.engine === 'physical') {
        d.name = CLASSIC_CABS.find(x => x.id === s.cab.physical.device)!.name
        d.description = 'C12N 线性机电与辐射近似；真实箱体及麦克风特性可通过 IR 扩展。'
        d.choices.push(choice('cab.physical.device', '箱体型号', CLASSIC_CABS))
        if (s.cab.physical.device === 'sealed412') d.parameters.push(p('cab.physical.volumeLitres', 'Volume', 10, 300, 1, ' L'))
        d.parameters.push(p('cab.physical.distanceMetres', 'Distance', .25, 3, .05, ' m'), p('cab.physical.micAngle', 'Angle', 0, 75, 1, '°'))
      } else {
        d.name = assets.find(a => a.id === s.cab.assetId)?.name ?? '箱体 IR'
        d.description = s.cab.secondaryAssetId ? '双 IR 混合 · 电平、声像与相位可独立调整。' : '导入实测箱体响应，可选第二个 IR 进行混合。'
        d.choices.push(choice('cab.assetId', '箱体 IR', assetsOf('ir')), choice('cab.secondaryAssetId', '第二个 IR', [{ id: '', name: '关闭' }, ...assetsOf('ir').slice(1)]))
        if (s.cab.secondaryAssetId) d.parameters.push(p('cab.blend', 'A / B'), p('cab.secondaryGainDb', 'B Level', -60, 24, .5, ' dB', 1), p('cab.secondaryDelayMs', 'B Delay', 0, 20, .01, ' ms'), p('cab.pan', 'A Pan', -1, 1, .01), p('cab.secondaryPan', 'B Pan', -1, 1, .01))
      }
      d.parameters.push(p('cab.lowCut', 'Low Cut', 20, 500, 5, ' Hz'), p('cab.highCut', 'High Cut', 1000, 20000, 100, ' Hz'), p('cab.gainDb', 'Level', -60, 24, .5, ' dB', 1))
      break
    }
    case 'eq': {
      d.name = s.eq.mode === 'parametric' ? 'Parametric EQ' : `${s.eq.bandCount} 段均衡`
      d.description = '塑造频谱，保留合适的低频厚度与高频清晰度。'
      d.choices.push(choice('eq.mode', '均衡类型', simple(['graphic', 'parametric'], ['图示均衡', '参数均衡'])))
      if (s.eq.mode === 'graphic') {
        d.choices.push({ ...choice('eq.bandCount', 'EQ 频段', simple(['5', '7'], ['5 段', '7 段'])), numeric: true })
        for (const [i, hz] of (s.eq.bandCount === 5 ? [80, 240, 750, 2200, 6600] : [100, 200, 400, 800, 1600, 3200, 6400]).entries()) d.parameters.push(p(`eq.bands.${i}`, `${hz} Hz`, -15, 15, .5, ' dB', 1))
      } else {
        for (let i = 0; i < 4; i++) d.parameters.push(p(`eq.parametric.${i}.frequency`, `${i + 1} · Freq`, 20, 20000, 1, ' Hz'), p(`eq.parametric.${i}.gain`, `${i + 1} · Gain`, -18, 18, .1, ' dB', 1), p(`eq.parametric.${i}.q`, `${i + 1} · Q`, .1, 12, .1))
        d.parameters.push(p('eq.lowCut', 'Low Cut', 20, 1000, 1, ' Hz'), p('eq.highCut', 'High Cut', 1000, 20000, 100, ' Hz'))
      }
      d.parameters.push(p('eq.gainDb', 'Level', -60, 24, .5, ' dB', 1))
      break
    }
    case 'mod': {
      const model = CLASSIC_MODS.find(x => x.id === s.mod.device)!
      d.name = model.name.split(' · ')[0]!
      d.description = model.description
      d.choices.push(choice('mod.device', '周边效果', CLASSIC_MODS))
      if (!['wah', 'ota-compressor'].includes(s.mod.device)) d.parameters.push(p('mod.rateHz', 'Rate', .05, 10, .05, ' Hz'))
      d.parameters.push(p('mod.depth', s.mod.device === 'wah' ? 'Resonance' : s.mod.device === 'ota-compressor' ? 'Sensitivity' : 'Depth'))
      if (!['optical-tremolo', 'vibrato'].includes(s.mod.device)) d.parameters.push(p('mod.mix', 'Mix'))
      if (['wah', 'ota-compressor', 'flanger'].includes(s.mod.device)) d.parameters.push(p('mod.manual', s.mod.device === 'wah' ? 'Position' : s.mod.device === 'ota-compressor' ? 'Recovery' : 'Manual'))
      if (s.mod.device === 'flanger') d.parameters.push(p('mod.feedback', 'Feedback', 0, .85, .01, '', 10))
      break
    }
    case 'delay':
      d.name = { digital: 'Digital', analog: 'Analog', tape: 'Tape', reverse: 'Reverse', pingpong: 'Ping-pong' }[s.delay.style]
      d.description = '选择回声质感，使用本地 BPM 与音符分割同步。'
      d.choices.push(choice('delay.style', '延迟类型', simple(['digital', 'analog', 'tape', 'reverse', 'pingpong'], ['Digital 数字延迟', 'Analog 暗色延迟', 'Tape 磁带回声', 'Reverse 反向延迟', 'Ping-pong 乒乓延迟'])))
      if (s.delay.sync) { d.parameters.push(p('delay.bpm', 'BPM', 20, 400, 1)); d.choices.push(choice('delay.division', '音符分割', simple(['1/4', '1/8', '1/8d', '1/16'], ['四分', '八分', '附点八分', '十六分']))) }
      else d.parameters.push(p('delay.timeMs', 'Time', 1, 2000, 1, ' ms'))
      d.parameters.push(p('delay.feedback', 'Feedback', 0, .95, .01, '', 10), p('delay.tone', 'Tone', 200, 16000, 100, ' Hz'), p('delay.mix', 'Mix'))
      break
    case 'reverb':
      d.name = { room: 'Room', hall: 'Hall', plate: 'Plate', spring: 'Spring' }[s.reverb.style]
      d.description = '从紧凑房间到开阔空间，调整衰减与高频吸收。'
      d.choices.push(choice('reverb.style', '混响类型', simple(['room', 'hall', 'plate', 'spring'])))
      d.parameters.push(p('reverb.decay', 'Decay', .1, 10, .1, ' s'), p('reverb.preDelayMs', 'Pre-delay', 0, 200, 1, ' ms'), p('reverb.damping', 'Damping'), p('reverb.mix', 'Mix'))
  }
  if(module.settings.dspRevision===1&&module.type==='dynamic')d.parameters=d.parameters.filter(p=>!['dynamic.knee','dynamic.mix','dynamic.hysteresis','dynamic.holdMs'].includes(p.path))
  return d
}

export function factoryPresets(): ArsenalPreset[] {
  const names = ['明亮清音', '温暖爵士', '布鲁斯边缘', '经典摇滚', '紧致高增益', '宽阔氛围', '贝斯通透 DI', '贝斯驱动']
  return names.map((name, i) => {
    const types: EffectBlock[] = i >= 6 ? ['dynamic', ...(i === 7 ? ['drive' as const] : []), 'eq'] : ['dynamic', ...(i >= 2 && i <= 4 ? ['drive' as const] : []), 'amp', 'cab', ...(i === 5 ? ['mod' as const] : []), 'delay', 'reverb']
    const modules = types.map((type, index) => { const m = createEffectModule(type); m.id = `factory-${i}-${index}`; return m })
    for (const m of modules) {
      const s = m.settings
      s.dynamic.threshold = i >= 6 ? -20 : -26; s.dynamic.ratio = i >= 6 ? 3 : 2; s.dynamic.mix = .65
      s.amp.classic.device = i === 3 ? '2203-pre' : i === 4 ? 'mesa' : 'ab763-pre'
      s.amp.classic.gain = [.22, .2, .38, .43, .6, .24][i] ?? .2; s.amp.classic.treble = i === 1 ? .32 : .55
      s.drive.device = i === 4 ? 'sd1' : i === 7 ? 'bd2' : 'ts808'; s.drive.drive = i === 7 ? .2 : .3; s.drive.level = .6
      s.cab.lowCut = 70; s.cab.highCut = i === 1 ? 4500 : 8500
      s.eq.mode = 'parametric'; s.eq.parametric[0]!.frequency = 80; s.eq.parametric[0]!.gain = i >= 6 ? 2 : 0; s.eq.lowCut = i >= 6 ? 30 : 70
      s.mod.device = 'chorus'; s.mod.mix = .25
      s.delay.style = 'tape'; s.delay.timeMs = i === 5 ? 480 : 280; s.delay.mix = i === 5 ? .3 : .1; s.delay.enabled = i >= 2
      s.reverb.style = i === 5 ? 'hall' : 'room'; s.reverb.mix = i === 5 ? .32 : .12; s.reverb.decay = i === 5 ? 4 : 1.4
    }
    return { id: `f0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, name, chain: { ...defaultEffectChain(), dspRevision: 2, modules }, revision: 1, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', factory: true, tags: [i >= 6 ? '贝斯' : '电吉他', i === 5 ? '氛围' : i === 4 ? '高增益' : i <= 1 ? '清音' : '通用'] }
  })
}
