import { useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { Appearance } from '@shared/appearance.js'
import { saveAppearance, useAppearance } from '../appearance.js'

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
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}
