import { Select } from '../components/ui/Select.js'
import { CLASSIC_AMPS, CLASSIC_CABS, CLASSIC_MODS, type EffectChainSnapshot, type ModulationSettings, type ToneAsset } from '@shared/arsenal.js'

function Parameter({ label, value, min = 0, max = 1, step = .01, onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; onChange(value: number): void
}): React.JSX.Element {
  const change = (v: number): void => { if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))) }
  return <label className="classic-parameter"><span>{label}</span>
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={e => change(e.target.valueAsNumber)} />
    <input aria-label={`${label} 数值`} type="number" min={min} max={max} step={step} value={Number(value.toFixed(3))} onChange={e => change(e.target.valueAsNumber)} />
  </label>
}

export function AmpCabControls({ chain, assets, update }: {
  chain: EffectChainSnapshot; assets: ToneAsset[]; update(patch: Partial<EffectChainSnapshot>): void
}): React.JSX.Element {
  const amp = chain.amp, cab = chain.cab
  return <div className="classic-rack">
    <section className="classic-module"><h3>箱头</h3>
      <label>箱头引擎<Select aria-label="箱头引擎" value={amp.engine} onChange={e => update({ amp: { ...amp, engine: e.target.value as typeof amp.engine } })}><option value="nam">NAM · 导入模型</option><option value="classic">白盒 · 前级电路</option></Select></label>
      {amp.engine === 'nam' ? <>
        <label>NAM 音色<Select aria-label="NAM 音色" value={amp.assetId ?? ''} onChange={e => update({ amp: { ...amp, assetId: e.target.value || null } })}><option value="">请选择已导入音色</option>{assets.filter(a => a.kind === 'nam').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></label>
        <label>模型质量<Select aria-label="模型质量" value={amp.quality} onChange={e => update({ amp: { ...amp, quality: e.target.value as 'full' | 'lite' } })}><option value="full">Full</option><option value="lite">Lite</option></Select></label>
      </> : <>
        <label>前级电路<Select aria-label="前级电路" value={amp.classic.device} onChange={e => update({ amp: { ...amp, classic: { ...amp.classic, device: e.target.value as typeof amp.classic.device } } })}>{CLASSIC_AMPS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></label>
        <p>{CLASSIC_AMPS.find(a => a.id === amp.classic.device)?.description}</p>
        <small>降阶前级研究模型 · 4× 过采样 · 未经实机校准，不代表完整箱头。</small>
        <div className="classic-parameters">{(['gain', 'bass', 'middle', 'treble', 'master'] as const).map((key, i) => <Parameter key={key} label={['Gain', 'Bass', 'Middle', 'Treble', 'Master'][i]!} value={amp.classic[key]} onChange={v => update({ amp: { ...amp, classic: { ...amp.classic, [key]: v } } })} />)}
          <Parameter label="箱头输入标定 V/FS" min={.1} max={10} step={.1} value={amp.classic.inputVolts} onChange={v => update({ amp: { ...amp, classic: { ...amp.classic, inputVolts: v } } })} />
        </div>
      </>}
    </section>
    <section className="classic-module"><h3>箱体 <label className="classic-switch"><input type="checkbox" checked={cab.enabled} onChange={e => update({ cab: { ...cab, enabled: e.target.checked } })} />箱体开启</label></h3>
      <label>箱体引擎<Select aria-label="箱体引擎" value={cab.engine} onChange={e => update({ cab: { ...cab, engine: e.target.value as typeof cab.engine } })}><option value="ir">IR · 导入脉冲响应</option><option value="physical">物理模型 · C12N</option></Select></label>
      {cab.engine === 'ir' ? <label>箱体 IR<Select aria-label="箱体 IR" value={cab.assetId ?? ''} onChange={e => update({ cab: { ...cab, assetId: e.target.value || null } })}><option value="">请选择已导入 IR</option>{assets.filter(a => a.kind === 'ir').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></label> : <>
        <label>箱体结构<Select aria-label="箱体结构" value={cab.physical.device} onChange={e => update({ cab: { ...cab, physical: { ...cab.physical, device: e.target.value as typeof cab.physical.device } } })}>{CLASSIC_CABS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        <p>{CLASSIC_CABS.find(c => c.id === cab.physical.device)?.description}</p>
        <small>厂商 T/S 参数 + 线性活塞模型；高频纸盆分割振动、近场麦克风与功放负载反馈未建模。</small>
        <div className="classic-parameters">
          {cab.physical.device === 'sealed412' && <Parameter label="密闭容积 L" value={cab.physical.volumeLitres} min={10} max={300} step={1} onChange={v => update({ cab: { ...cab, physical: { ...cab.physical, volumeLitres: v } } })} />}
          <Parameter label="远场距离 m" value={cab.physical.distanceMetres} min={.25} max={3} step={.05} onChange={v => update({ cab: { ...cab, physical: { ...cab.physical, distanceMetres: v } } })} />
          <Parameter label="离轴角度 °（近似）" value={cab.physical.micAngle} min={0} max={75} step={1} onChange={v => update({ cab: { ...cab, physical: { ...cab.physical, micAngle: v } } })} />
        </div>
      </>}
      <div className="classic-parameters">
        <Parameter label="箱体增益 dB" value={cab.gainDb} min={-60} max={24} step={.5} onChange={gainDb => update({ cab: { ...cab, gainDb } })} />
        <Parameter label="箱体低切 Hz" value={cab.lowCut} min={20} max={500} step={1} onChange={lowCut => update({ cab: { ...cab, lowCut } })} />
        <Parameter label="箱体高切 Hz" value={cab.highCut} min={1000} max={20000} step={100} onChange={highCut => update({ cab: { ...cab, highCut } })} />
      </div>
    </section>
    <section className="classic-module classic-levels"><Parameter label="输入增益 dB" min={-60} max={24} step={.5} value={chain.inputGainDb} onChange={inputGainDb => update({ inputGainDb })} /><Parameter label="输出增益 dB" min={-60} max={24} step={.5} value={chain.outputGainDb} onChange={outputGainDb => update({ outputGainDb })} /></section>
  </div>
}

export function ModulationControls({ value, onChange }: { value: ModulationSettings; onChange(value: ModulationSettings): void }): React.JSX.Element {
  const patch = (v: Partial<ModulationSettings>): void => onChange({ ...value, ...v })
  const hasRate = !['wah', 'ota-compressor'].includes(value.device)
  return <div className="classic-module"><label>调制与动态设备<Select aria-label="调制与动态设备" value={value.device} onChange={e => patch({ device: e.target.value as ModulationSettings['device'] })}>{CLASSIC_MODS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>
    <p>{CLASSIC_MODS.find(m => m.id === value.device)?.description}</p>
    <div className="classic-parameters">
      {hasRate && <Parameter label="Rate Hz" min={.05} max={10} step={.05} value={value.rateHz} onChange={rateHz => patch({ rateHz })} />}
      <Parameter label={value.device === 'wah' ? 'Resonance' : value.device === 'ota-compressor' ? 'Sensitivity' : 'Depth'} value={value.depth} onChange={depth => patch({ depth })} />
      {value.device !== 'optical-tremolo' && <Parameter label="Mix" value={value.mix} onChange={mix => patch({ mix })} />}
      {['wah', 'ota-compressor', 'flanger'].includes(value.device) && <Parameter label={value.device === 'wah' ? '踏板位置' : value.device === 'ota-compressor' ? '恢复时间' : 'Manual'} value={value.manual} onChange={manual => patch({ manual })} />}
      {value.device === 'flanger' && <Parameter label="Feedback" min={0} max={.85} value={value.feedback} onChange={feedback => patch({ feedback })} />}
    </div><small>未经过实机校准。此槽每次选择一种设备，可在信号链中移动位置。</small>
  </div>
}
