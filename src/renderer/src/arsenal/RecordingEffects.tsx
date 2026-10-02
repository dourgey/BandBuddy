import { useEffect, useRef, useState } from 'react'
import { chainModules, defaultEffectChain, type ArsenalState, type TrackEffects } from '@shared/arsenal.js'
import type { RecordingTrackState } from '@shared/domain.js'
import { ModuleControls } from './ModuleControls.js'
import '../pages/arsenal.css'
export function RecordingEffects({ track, busy, onChanged }: { track: RecordingTrackState; busy: boolean; onChanged?(): void }): React.JSX.Element {
  const [library, setLibrary] = useState<ArsenalState>({ presets: [], assets: [] })
  const [effects, setEffects] = useState<TrackEffects>(track.effects ?? { enabled: false, presetId: null, chain: defaultEffectChain(), monitorMode: 'off' })
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [editing, setEditing] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve()), revision = useRef(0)
  useEffect(() => { void window.bandbuddy.arsenal.list().then(setLibrary).catch(e => setError(String(e))) }, [])
  useEffect(() => { if (track.effects) setEffects(track.effects) }, [track.effects])
  const apply = (next: TrackEffects): void => {
    setEffects(next); setSaving(true); setError(''); const version = ++revision.current
    queue.current = queue.current.catch(() => undefined).then(() => window.bandbuddy.arsenal.setTrack({ trackId: track.id, effects: next })).then(() => {
      if (version === revision.current) onChanged?.()
    }).catch(e => setError(String(e))).finally(() => { if (version === revision.current) setSaving(false) })
  }
  const choose = (id: string): void => {
    const preset = library.presets.find(p => p.id === id)
    apply(preset ? { enabled: true, presetId: id, chain: preset.chain, monitorMode: 'wet' } : { ...effects, enabled: false, presetId: null, monitorMode: 'dry' })
  }
  return <div className="recording-effects">
    <label>音色<select aria-label={`${track.name} 音色预设`} disabled={busy} value={effects.presetId ?? ''} onFocus={() => { void window.bandbuddy.arsenal.list().then(setLibrary).catch(e => setError(String(e))) }} onChange={e => choose(e.target.value)}><option value="">干声</option>{library.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>录制监听<select disabled={busy} value={effects.monitorMode} aria-label={`${track.name} 监听方式`} onChange={e => apply({ ...effects, monitorMode: e.target.value as TrackEffects['monitorMode'] })}><option value="off">关闭</option><option value="dry">干声</option><option value="wet">效果声</option></select></label>
    <label><input type="checkbox" disabled={busy} checked={effects.enabled} onChange={e => apply({ ...effects, enabled: e.target.checked })} />效果回放</label>
    <button disabled={busy || !effects.presetId} onClick={() => choose(effects.presetId!)}>同步已保存预设</button>
    <button disabled={busy} onClick={() => setEditing(!editing)}>调整本轨音色</button>
    <small>{saving ? '正在更新音色…' : '始终录制干声 · 监听需同一声卡输入输出'}</small>
    {error && <p role="alert">{error}</p>}
    {editing && <div className="recording-effect-editor">{chainModules(effects.chain).map((module, index) => <details key={module.id}><summary>{index + 1}. {module.type.toUpperCase()}</summary><ModuleControls module={module} assets={library.assets} onChange={next => apply({ ...effects, chain: { ...effects.chain, modules: chainModules(effects.chain).map(m => m.id === next.id ? next : m) } })} /></details>)}</div>}
  </div>
}
