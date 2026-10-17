import { useEffect, useState } from 'react'
import type { ExternalPlugin, PluginCatalog, PluginDefinition, PluginParameter } from '@shared/audio-plugins.js'
import { chainModules, type EffectChainSnapshot } from '@shared/arsenal.js'
import { Select } from '../components/ui/Select.js'
import './local-plugins.css'

export function LocalPlugins({ chain, active, locked, onChange }: { chain: EffectChainSnapshot; active: boolean; locked: boolean; onChange(chain: EffectChainSnapshot): void }): React.JSX.Element | null {
  const api = window.bandbuddy.audioPlugins
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('')
  const [parameters, setParameters] = useState<{ id: string; values: PluginParameter[] } | null>(null)
  const [health, setHealth] = useState('')
  const nodes = chain.plugins ?? [], modules = chainModules(chain)
  useEffect(() => { void api?.list().then(setCatalog).catch(e => setError(String(e))) }, [api])
  useEffect(() => {
    if (!active || !nodes.length || !api) { setHealth(''); return }
    let alive = true
    const timer = setInterval(() => { void api.status().then(state => { if (alive) setHealth(state.fault ? `插件链已静音，原始干声仍可录制。${state.error ?? ''}` : '') }).catch(error => { if (alive) setHealth(String(error)) }) }, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [api, active, nodes.length])
  if (!api) return null
  const run = (action: () => Promise<unknown>): void => { setBusy(true); setError(''); void action().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)) }
  const update = (node: ExternalPlugin): void => onChange({ ...chain, plugins: nodes.map(p => p.instanceId === node.instanceId ? node : p) })
  const add = (plugin: PluginDefinition): void => onChange({ ...chain, plugins: [...nodes, { instanceId: crypto.randomUUID(), format: plugin.format, pluginId: plugin.pluginId, name: plugin.name, fingerprint: plugin.fingerprint, stateHash: null, bypass: false, beforeModuleId: null }] })
  return <details className="local-plugins" open={nodes.length > 0 || undefined}>
    <summary>本机效果插件 <span>{nodes.length ? `${nodes.length} 个实例` : 'VST3 / Audio Units'}</span></summary>
    <div className="plugin-toolbar"><input aria-label="搜索本机插件" placeholder="搜索名称或厂商" value={query} onChange={e => setQuery(e.target.value)} />
      <button disabled={busy || active || locked} onClick={() => run(async () => setCatalog(await api.scan()))}>{busy ? '处理中…' : '扫描插件'}</button>
      <button disabled={busy || active || locked} onClick={() => run(async () => setCatalog(await api.addDirectory()))}>添加目录</button>
    </div>
    {(error || health) && <p role="alert" className="plugin-error">{error || health}</p>}
    <p className="plugin-note">使用当前系统与处理器架构的效果插件。先扫描，再添加到效果链；乐器插件需要 MIDI 轨。保存预设时会保留完整插件状态。</p>
    <div className="plugin-catalog">{catalog?.plugins.filter(p => `${p.name} ${p.manufacturer}`.toLowerCase().includes(query.toLowerCase())).map(p =>
      <div key={`${p.format}:${p.pluginId}`}><span><b>{p.name}</b><small>{p.manufacturer} · {p.format.toUpperCase()} · {p.validation === 'available' ? `${p.inputChannels} → ${p.outputChannels} 声道` : p.failureReason}</small></span><button disabled={locked || busy || p.validation !== 'available'} onClick={() => add(p)}>添加</button></div>)}
      {!catalog?.plugins.length && <p className="plugin-note">尚未扫描到插件。扫描不会向声卡输出测试声音。</p>}
    </div>
    {Boolean(catalog?.failures.length) && <details><summary>扫描失败 / 已隔离（{catalog!.failures.length}）</summary>{catalog!.failures.map(f => <p key={f.path} className="plugin-note">{f.path}<br/>{f.reason}</p>)}<button disabled={busy || active || locked} onClick={() => run(async () => setCatalog(await api.scan(true)))}>重新验证失败插件</button></details>}
    <ol className="plugin-instances">{nodes.map((node, index) => {
      const available = catalog?.plugins.find(p => p.pluginId === node.pluginId && p.format === node.format && p.fingerprint === node.fingerprint)
      return <li key={node.instanceId}><div><b>{node.name}</b><small>{node.format.toUpperCase()} · {available ? node.stateHash ? '已保存状态' : '当前状态未保存' : '缺失或版本变化，原状态已保留'}</small></div>
        <label>处理位置<Select aria-label={`${node.name} 处理位置`} disabled={locked} value={node.beforeModuleId ?? ''} onChange={e => update({ ...node, beforeModuleId: e.target.value || null })}><option value="">效果链末尾</option>{modules.map((m, i) => <option key={m.id} value={m.id}>模块 {i + 1}（{m.type}）之前</option>)}</Select></label>
        <div className="plugin-actions"><button disabled={!active || busy || locked || available?.hasEditor === false} title={available?.hasEditor === false ? '该插件没有原生界面，可以使用参数面板' : undefined} onClick={() => run(() => api.editor(node.instanceId))}>打开界面</button>
          <button disabled={!active || busy || locked} onClick={() => run(async () => setParameters({ id: node.instanceId, values: await api.parameters(node.instanceId) }))}>参数</button>
          <button disabled={!active || busy || locked} onClick={() => run(async () => update({ ...node, stateHash: await api.save(node.instanceId) }))}>保存状态</button>
          <button disabled={locked} aria-pressed={node.bypass} onClick={() => update({ ...node, bypass: !node.bypass })}>{node.bypass ? '启用' : '旁路'}</button>
          <button disabled={locked || !index} aria-label={`上移 ${node.name}`} onClick={() => { const next = [...nodes]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange({ ...chain, plugins: next }) }}>上移</button>
          <button disabled={locked} aria-label={`移除 ${node.name}`} onClick={() => onChange({ ...chain, plugins: nodes.filter(p => p.instanceId !== node.instanceId) })}>移除</button>
        </div>
        {parameters?.id === node.instanceId && <div className="plugin-parameters">{parameters.values.map(p => <label key={p.id}>{p.name}<input aria-label={`${node.name} ${p.name}`} type="range" min={0} max={1} step={p.steps ? 1 / p.steps : .001} disabled={p.readOnly || !active || locked} value={p.value} onChange={e => { const value = Number(e.target.value); setParameters({ id: node.instanceId, values: parameters.values.map(v => v.id === p.id ? { ...v, value } : v) }); void api.parameter(node.instanceId, p.id, value).catch(e => setError(String(e))) }} /></label>)}</div>}
      </li>
    })}</ol>
  </details>
}
