import { MODELED_CABS, isModeledAmp } from './amp-cab-catalog.js'
import { effectIdentity, type EffectIdentity } from './effect-identities.js'
import { CLASSIC_AMPS, CLASSIC_CABS, CLASSIC_MODS, WHITEBOX_DEVICES, createEffectModule, defaultEffectChain, effectModuleSchema, type ArsenalPreset, type EffectBlock, type EffectModule, type ToneAsset } from './arsenal.js'

export const EFFECT_LABELS: Record<EffectBlock, string> = { dynamic: '动态', drive: 'Drive', amp: 'AMP', cab: 'CAB', eq: 'EQ', mod: '调制', delay: 'Delay', reverb: 'Reverb' }
export interface ParameterDefinition { path: string; label: string; min: number; max: number; step: number; unit: string; scale: number; advanced?: boolean }
export interface ChoiceDefinition { path: string; label: string; options: { id: string; name: string }[]; numeric?: boolean; advanced?: boolean }
export interface EffectDefinition { name: string; description: string; identity?: EffectIdentity; parameters: ParameterDefinition[]; choices: ChoiceDefinition[] }
const p = (path: string, label: string, min = 0, max = 1, step = .01, unit = '', scale = max === 1 && min === 0 ? 10 : 1, advanced = false): ParameterDefinition => ({ path, label, min, max, step, unit, scale, advanced })
const choice = (path: string, label: string, options: readonly { id: string; name: string }[], advanced = false): ChoiceDefinition => ({ path, label, options: [...options], advanced })
const simple = (ids: string[], names = ids) => ids.map((id, i) => ({ id, name: names[i]! }))
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
      d.choices.push(choice('dynamic.device', '动态类型', ['compressor','boost','gate'].map(id=>({id,name:effectIdentity('dynamic',id)!.name}))))
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
        d.name = CLASSIC_AMPS.find(x => x.id === s.amp.classic.device)!.name
        d.description = CLASSIC_AMPS.find(x => x.id === s.amp.classic.device)!.description
        d.choices.push(choice('amp.classic.device', '箱头型号', CLASSIC_AMPS.filter(a => isModeledAmp(a.id) || a.id === s.amp.classic.device).map(a => ({ id: a.id, name: a.name + (isModeledAmp(a.id) ? '' : '（旧版）') }))))
        const nonMaster = ['fender-twin', 'marshall-jtm45', 'vox-ac30'].includes(s.amp.classic.device)
        for (const key of (s.amp.classic.device === 'vox-ac30' ? ['gain', 'bass', 'treble', 'cut', 'master'] : ['gain', 'bass', 'middle', 'treble', 'master'])) d.parameters.push(p(`amp.classic.${key}`, key === 'master' && nonMaster ? 'LEVEL' : key.toUpperCase()))
        if (isModeledAmp(s.amp.classic.device)) {
          if (s.amp.classic.device !== 'vox-ac30' && s.amp.classic.device !== 'fender-twin') d.parameters.push(p('amp.classic.presence', 'PRESENCE'))
          d.parameters.push(p('amp.classic.sag', '供电压降', 0, 1, .01, '', 10, true))
          d.choices.push({ ...choice('amp.classic.oversampling', '箱头过采样', simple(['2', '4'], ['2× · 低负载', '4× · 推荐']), true), numeric: true })
          d.choices.push(choice('amp.classic.load', '功放负载', simple(['auto', 'resistive'], ['自动匹配箱体', '8Ω 电阻']), true))
          d.description += ' 2× / 4× 过采样；未经实机标定。自动负载匹配紧邻的物理箱体，IR 或无相邻箱体时使用本型号默认负载。'
          if (nonMaster) d.description += ' LEVEL 为功放后的软件输出电平。'
        }
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
      // A single cabinet selector: IR is one cabinet type, not a separate rack engine.
      if (s.cab.engine === 'physical') {
        const model = CLASSIC_CABS.find(x => x.id === s.cab.physical.device)!
        const modeled = MODELED_CABS.find(x => x.id === s.cab.physical.device)
        d.name = model.name
        d.description = model.description + (modeled ? ' 线性机电与声学降阶模型，未经实机标定。' : '')
        if (modeled?.sealed || s.cab.physical.device === 'sealed412') d.parameters.push(p('cab.physical.volumeLitres', 'Volume', 10, 300, 1, ' L', 1, true))
        d.parameters.push(p('cab.physical.distanceMetres', 'Distance', .25, 3, .05, ' m'), p('cab.physical.micAngle', 'Angle', 0, 75, 1, '°'))
      } else {
        d.name = assets.find(a => a.id === s.cab.assetId)?.name ?? '箱体 IR'
        d.description = '保留原始 IR 的电平、声道和相位；设备采样率不同时自动重采样。'
        d.choices.push(choice('cab.secondaryAssetId', '第二个 IR', [{ id: '', name: '关闭' }, ...assetsOf('ir').slice(1)], true))
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
      if(s.mod.device==='fixed-wah'){
        d.parameters.push(p('mod.manual','Peak'),p('mod.depth','Q'),p('mod.levelDb','Level',-24,20,.5,' dB',1));break
      }
      if(s.mod.device==='stereo-chorus'){
        d.parameters.push(p('mod.rateHz','Rate',.1,10,.05,' Hz'),p('mod.depth','Width'),p('mod.mix','Intensity'),p('mod.bass','Bass'),p('mod.treble','Treble'));break
      }
      if(s.mod.device==='step-flanger'){
        d.choices.push(choice('mod.sweepMode','调制模式',simple(['sweep','step','dynamic'],['Sweep 扫动','Step 八步','Dynamic 包络'])))
        d.parameters.push(p('mod.rateHz',s.mod.sweepMode==='dynamic'?'Sensitivity':'Rate',0,10,.05,s.mod.sweepMode==='dynamic'?'':' Hz'),p('mod.depth',s.mod.sweepMode==='step'?'Sequence':s.mod.sweepMode==='dynamic'?'Direction':'Depth'),p('mod.feedback','Regen',-.85,.85,.01,'',10),p('mod.mix','Mix'));break
      }
      if(s.mod.device==='aqueduct-vibrato'){
        d.choices.push(choice('mod.waveform','颤音模式',simple(['sine','triangle','ramp','square','random','env-depth','env-rate','env-pitch'],['Sine 正弦','Triangle 三角','Ramp 斜坡','Square 方波','Random 随机','Env D 包络深度','Env R 包络速度','Env P 包络音高'])))
        const sensitive=['env-rate','env-pitch'].includes(s.mod.waveform)
        d.parameters.push(p('mod.rateHz',sensitive?'Sensitivity':'Rate',.05,10,.05,sensitive?'':' Hz'),p('mod.depth',s.mod.waveform==='env-pitch'?'Mix':s.mod.waveform==='env-depth'?'Sensitivity':'Depth'));break
      }
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
      d.choices.push(choice('delay.style', '延迟类型', ['digital','analog','tape','reverse','pingpong'].map(id=>({id,name:effectIdentity('delay',id)!.name}))))
      if (s.delay.sync) { d.parameters.push(p('delay.bpm', 'BPM', 20, 400, 1)); d.choices.push(choice('delay.division', '音符分割', simple(['1/4', '1/8', '1/8d', '1/16'], ['四分', '八分', '附点八分', '十六分']))) }
      else d.parameters.push(p('delay.timeMs', 'Time', 1, 2000, 1, ' ms'))
      d.parameters.push(p('delay.feedback', 'Feedback', 0, .95, .01, '', 10), p('delay.tone', 'Tone', 200, 16000, 100, ' Hz'), p('delay.mix', 'Mix'))
      break
    case 'reverb':
      d.name = { room: 'Room', hall: 'Hall', plate: 'Plate', spring: 'Spring' }[s.reverb.style]
      d.description = '从紧凑房间到开阔空间，调整衰减与高频吸收。'
      d.choices.push(choice('reverb.style', '混响类型', ['room','hall','plate','spring'].map(id=>({id,name:effectIdentity('reverb',id)!.name}))))
      d.parameters.push(p('reverb.decay', 'Decay', .1, 10, .1, ' s'), p('reverb.preDelayMs', 'Pre-delay', 0, 200, 1, ' ms'), p('reverb.damping', 'Damping'), p('reverb.mix', 'Mix'))
  }
  const id=module.type==='amp'?(s.amp.engine==='classic'?s.amp.classic.device:''):module.type==='cab'?(s.cab.engine==='physical'?s.cab.physical.device:''):module.type==='drive'?s.drive.device:module.type==='mod'?s.mod.device:module.type==='dynamic'?s.dynamic.device:module.type==='eq'?s.eq.mode:module.type==='delay'?s.delay.style:s.reverb.style
  d.identity=effectIdentity(module.type,id)
  if(d.identity)d.name=module.type==='eq'&&s.eq.mode==='graphic'&&s.eq.bandCount===5?'Graphic EQ 05':d.identity.name
  if(module.settings.dspRevision===1&&module.type==='dynamic')d.parameters=d.parameters.filter(p=>!['dynamic.knee','dynamic.mix','dynamic.hysteresis','dynamic.holdMs'].includes(p.path))
  return d
}

export function factoryPresets(): ArsenalPreset[] {
  return []
}
