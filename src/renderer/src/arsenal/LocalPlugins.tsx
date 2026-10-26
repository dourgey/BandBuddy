import { useEffect, useRef, useState } from 'react'
import type { ExternalPlugin, PluginCatalog, PluginDefinition, PluginParameter } from '@shared/audio-plugins.js'
import { Select } from '../components/ui/Select.js'
import './local-plugins.css'

export function useLocalPlugins(active: boolean, locked: boolean, instances: number) {
  const api = window.bandbuddy.audioPlugins
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [error, setError] = useState(''), [health, setHealth] = useState(''), [scanning, setScanning] = useState(false)
  useEffect(() => {
    let alive = true
    void api?.list().then(value => { if (alive) setCatalog(current => current ?? value) }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [api])
  useEffect(() => {
    if (!api || active || locked) { setScanning(false); return }
    let alive = true, running = false
    const refresh = async (): Promise<void> => {
      if (running) return
      running = true; setScanning(true)
      try {
        const value = await api.scan()
        if (alive) { setCatalog(value); setError('') }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)) }
      finally { running = false; if (alive) setScanning(false) }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 30_000)
    const focus = (): void => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [api, active, locked])
  useEffect(() => {
    if (!active || !instances || !api) { setHealth(''); return }
    let alive = true
    const timer = setInterval(() => { void api.status().then(state => { if (alive) setHealth(state.fault ? `插件链已静音，原始干声仍可录制。${state.error ?? ''}` : '') }).catch(e => { if (alive) setHealth(String(e)) }) }, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [api, active, instances])
  return { catalog, scanning, error: health || error, dismissError: (): void => { setError(''); setHealth('') } }
}

export function PluginPicker({ catalog, scanning, locked, onAdd }: { catalog: PluginCatalog | null; scanning: boolean; locked: boolean; onAdd(plugin: PluginDefinition): void }): React.JSX.Element | null {
  if (!window.bandbuddy.audioPlugins) return null
  const effects = catalog?.plugins.filter(p => p.validation === 'available' && !p.instrument) ?? []
  return <Select aria-label="添加 VST 插件" value="" disabled={locked || !effects.length} onChange={e => {
    const plugin = effects.find(p => `${p.format}:${p.pluginId}` === e.target.value)
    if (plugin) onAdd(plugin)
  }}><option value="" disabled>{effects.length ? 'VST' : scanning ? 'VST · 扫描中…' : 'VST · 暂无效果'}</option>{effects.map(p => <option key={`${p.format}:${p.pluginId}`} value={`${p.format}:${p.pluginId}`}>{p.name}</option>)}</Select>
}

export function PluginControls({ plugin, definition, active, locked, onActivate, openRequest = 0, onRequestConsumed }: { plugin: ExternalPlugin; definition?: PluginDefinition; active: boolean; locked: boolean; onActivate(): Promise<void>; openRequest?: number; onRequestConsumed?(): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [parameters, setParameters] = useState<PluginParameter[]>([])
  const opening = useRef(false), lastRequest = useRef(0)
  const api = window.bandbuddy.audioPlugins
  const open = (): void => {
    if (opening.current || locked || !definition || definition.validation !== 'available') return
    opening.current = true
    setBusy(true); setError('')
    void (async () => {
      if (!api) throw new Error('插件宿主不可用')
      await onActivate()
      if (definition?.hasEditor === false) setParameters(await api.parameters(plugin.instanceId))
      else await api.editor(plugin.instanceId)
    })().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => { opening.current = false; setBusy(false) })
  }
  // A rack click can target an already selected node. Consume each explicit
  // request once, including when the catalogue arrives after the selection.
  useEffect(() => {
    if (!openRequest || openRequest === lastRequest.current || locked || !definition) return
    lastRequest.current = openRequest
    onRequestConsumed?.()
    open()
  })
  return <div className="plugin-controls">
    <h2>{plugin.name}</h2>
    <button className="primary" disabled={locked || busy || !definition || definition.validation !== 'available'} onClick={open}>{busy ? '正在打开…' : definition?.hasEditor === false ? '编辑参数' : '打开插件'}</button>
    {!definition && <p className="plugin-error">插件缺失或版本变化，原状态已保留。</p>}
    {error && <p role="alert" className="plugin-error">{error}</p>}
    {Boolean(parameters.length) && <div className="plugin-parameters">{parameters.map(p => <label key={p.id}>{p.name}<input aria-label={`${plugin.name} ${p.name}`} type="range" min={0} max={1} step={p.steps ? 1 / p.steps : .001} disabled={p.readOnly || locked || !active} value={p.value} onChange={e => {
      const value = Number(e.target.value)
      setParameters(previous => previous.map(v => v.id === p.id ? { ...v, value } : v))
      void api?.parameter(plugin.instanceId, p.id, value).catch(e => setError(String(e)))
    }} /></label>)}</div>}
  </div>
}
