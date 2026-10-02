import { useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { Appearance } from '@shared/appearance.js'
import { saveAppearance, useAppearance } from '../appearance.js'
import { Select } from './ui/Select.js'

export function AppearanceSettings({ onSaved }: { onSaved?(appearance: Appearance): void }): React.JSX.Element {
  const appearance = useAppearance()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const change = async (patch: Partial<Appearance>): Promise<void> => {
    setSaving(true); setError('')
    try { const saved = await saveAppearance({ ...appearance, ...patch }); onSaved?.(saved) }
    catch { setError('外观偏好保存失败，已恢复之前的设置，请重试。') }
    finally { setSaving(false) }
  }
  return <section className="settings-section bb-appearance" aria-label="外观设置">
    <h3><Sun size={17} />外观与显示</h3>
    <div className="bb-theme-options" role="group" aria-label="界面主题">
      {([{ value: 'warm', label: '暖纸色', Icon: Sun }, { value: 'dark', label: '深色', Icon: Moon }, { value: 'system', label: '跟随系统', Icon: Monitor }] as const).map(({ value, label, Icon }) => <button key={value} type="button" className="bb-theme-option" aria-pressed={appearance.theme === value} disabled={saving} onClick={() => void change({ theme: value })}><span className={`bb-theme-preview ${value}`} aria-hidden="true"><i /><b /></span><span><Icon size={13} /> {label}</span></button>)}
    </div>
    <div className="settings-grid">
      <label>界面密度<Select aria-label="界面密度" value={appearance.density} disabled={saving} onChange={event => void change({ density: event.target.value as Appearance['density'] })}><option value="normal">普通 · 留出呼吸空间</option><option value="compact">紧凑 · 显示更多内容</option></Select></label>
      <label>视觉效果<Select aria-label="视觉效果" value={appearance.effects} disabled={saving} onChange={event => void change({ effects: event.target.value as Appearance['effects'] })}><option value="standard">标准</option><option value="reduced">精简 · 减少动画与阴影</option></Select></label>
    </div>
    <p className="security-note">立即生效，自动保存。不会中断播放、录音或重新检测运行环境。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}
