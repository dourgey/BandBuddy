import { WHITEBOX_DEVICES, type WhiteboxSettings } from '@shared/arsenal.js'

export function WhiteboxControls({ value, onChange }: {
  value: WhiteboxSettings
  onChange(value: WhiteboxSettings): void
}): React.JSX.Element {
  const device = WHITEBOX_DEVICES.find(d => d.id === value.device)!
  const patch = (change: Partial<WhiteboxSettings>): void => onChange({ ...value, ...change })
  return <div className="whitebox-controls">
    <div className="whitebox-device">
      <label>经典设备<select aria-label="经典设备" value={value.device} onChange={e => patch({ device: e.target.value as WhiteboxSettings['device'] })}>
        {WHITEBOX_DEVICES.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select></label>
      <p>{device.description}</p>
      <small>电路削波核心 + 简化运放与音调网络；尚未通过实机对照校准。</small>
    </div>
    <div className="whitebox-parameters">
      {(['drive', 'tone', 'level'] as const).map(key => {
        const label = key === 'drive' ? (value.device === 'rat' ? 'Distortion' : 'Drive') : key === 'tone' ? (value.device === 'rat' ? 'Filter · 越大越暗' : 'Tone') : 'Level'
        return <label key={key} className="whitebox-parameter"><span>{label}</span>
          <input aria-label={label} type="range" min={0} max={100} step={1} value={Math.round(value[key] * 100)} onChange={e => patch({ [key]: Number(e.target.value) / 100 })} />
          <input aria-label={`${label} 数值`} type="number" min={0} max={100} step={1} value={Math.round(value[key] * 100)} onChange={e => { const v = e.target.valueAsNumber; if (Number.isFinite(v)) patch({ [key]: Math.min(100, Math.max(0, v)) / 100 }) }} />
        </label>
      })}
    </div>
    <div className="whitebox-calibration">
      <label>输入标定 · V / 满幅<input aria-label="输入标定" type="number" min={.1} max={10} step={.1} value={value.inputVolts} onChange={e => { const v = e.target.valueAsNumber; if (Number.isFinite(v) && v >= .1 && v <= 10) patch({ inputVolts: v }) }} /></label>
      <label>过采样<select aria-label="过采样" value={value.oversampling} onChange={e => patch({ oversampling: Number(e.target.value) as 2 | 4 })}><option value={2}>2× · 较低负载</option><option value={4}>4× · 推荐</option></select></label>
      <small>默认 1 V 是起点，请按声卡输入增益标定。设备和过采样切换会重新加载。</small>
    </div>
  </div>
}
