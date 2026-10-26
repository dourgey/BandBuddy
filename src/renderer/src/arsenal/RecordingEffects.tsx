import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Headphones, Trash2 } from 'lucide-react'
import { defaultEffectChain, type ArsenalState, type ArsenalMonitorState, type TrackEffects } from '@shared/arsenal.js'
import type { RecordingTrackState } from '@shared/domain.js'
import { prepareNativeOutput, restoreBrowserOutput } from './output-coordinator.js'
import { TrackMeter } from '../components/TrackMeter.js'
import { useRecordingPlayback } from '../recording-playback-state.js'

export function RecordingEffects({ track, busy, recording = false, onChanged, controls, onDelete, deleteDisabled, inputPeak }: {
  track: RecordingTrackState; busy: boolean; recording?: boolean; onChanged?(): void; controls?: ReactNode; onDelete?(): void; deleteDisabled?: boolean; inputPeak?: number
}): React.JSX.Element {
  const [library, setLibrary] = useState<ArsenalState>({ presets: [], assets: [] })
  const [effects, setEffects] = useState<TrackEffects>(track.effects ?? { enabled: false, presetId: null, chain: defaultEffectChain(), monitorMode: 'off' })
  const [monitor, setMonitor] = useState<ArsenalMonitorState | null>(null)
  const [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve()), revision = useRef(0)
  const playback = useRecordingPlayback(state => state.tracks[track.id])
  const monitoring = recording ? effects.monitorMode !== 'off' : Boolean(monitor?.active && monitor.trackId === track.id)
  useEffect(() => {
    void window.bandbuddy.arsenal.list().then(setLibrary).catch(e => setError(String(e)))
    let live = true
    const unsubscribe = window.bandbuddy.arsenal.onMonitor(state => { if (live) setMonitor(state) })
    void window.bandbuddy.arsenal.monitorState().then(state => { if (live) setMonitor(state) }).catch(e => setError(String(e)))
    return () => { live = false; unsubscribe() }
  }, [])
  useEffect(() => { if (track.effects) setEffects(track.effects) }, [track.effects])
  // Capture completion returns to file playback. Live input is explicitly
  // enabled with the headphones control, never reopened by an idle render.
  useEffect(() => () => {
    void window.bandbuddy.arsenal.monitor({ mode: 'off', chain: defaultEffectChain(), trackId: track.id }).catch(() => undefined)
  }, [track.id])
  const apply = (next: TrackEffects): void => {
    const previous = effects
    setEffects(next); setSaving(true); setError(''); const version = ++revision.current
    queue.current = queue.current.catch(() => undefined).then(async () => {
      try {
        if (!recording && next.monitorMode !== 'off' && !monitor?.active) await prepareNativeOutput()
        await window.bandbuddy.arsenal.setTrack({ trackId: track.id, effects: next })
      }
      catch (e) { if (!recording && !monitor?.active) await restoreBrowserOutput(); throw e }
    }).then(() => {
      if (version === revision.current) onChanged?.()
    }).catch(e => { if (version === revision.current) { setEffects(previous); setError(String(e)) } }).finally(() => { if (version === revision.current) setSaving(false) })
  }
  const choose = (id: string): void => {
    const preset = library.presets.find(p => p.id === id)
    apply(preset ? { enabled: true, presetId: id, chain: preset.chain, monitorMode: monitoring ? 'wet' : 'off' } : { ...effects, enabled: false, presetId: null, monitorMode: monitoring ? 'dry' : 'off' })
  }
  return <div className="recording-controls">
    <span className="ms-buttons">{controls}<button className={monitoring ? 'active monitor-button' : 'monitor-button'} aria-label={`${track.name}监听`} title="监听输入" aria-pressed={monitoring} disabled={busy || saving} onClick={() => apply({ ...effects, monitorMode: monitoring ? 'off' : effects.enabled ? 'wet' : 'dry' })}><Headphones size={15} /></button></span>
    <TrackMeter id={track.id} livePeak={recording ? inputPeak : monitoring && !track.activeTakeId ? Math.max(...(monitor?.peak ?? []), 0) : undefined} />
    <div className="recording-tone-actions">
      <select title="音色" aria-label={`${track.name} 音色预设`} disabled={busy || saving} value={effects.presetId ?? ''} onFocus={() => { void window.bandbuddy.arsenal.list().then(setLibrary).catch(e => setError(String(e))) }} onChange={e => choose(e.target.value)}><option value="">干声</option>{effects.presetId && !library.presets.some(p => p.id === effects.presetId) && <option value={effects.presetId}>已保存音色</option>}{library.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button disabled={deleteDisabled} title="删除录音轨及全部 Take" aria-label={`删除${track.name}轨道`} onClick={onDelete}><Trash2 size={13} /></button>
    </div>
    {!recording && playback?.phase === 'loading' && <small role="status">正在连接录音轨…</small>}
    {!recording && playback?.phase === 'failed' && <button className="recording-retry" title={playback.error} onClick={onChanged}>回放加载失败，重试</button>}
    {error && <p className="recording-control-error" role="alert">{error}</p>}
  </div>
}
