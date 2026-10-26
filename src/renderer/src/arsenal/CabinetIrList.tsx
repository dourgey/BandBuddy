import { useMemo, useState } from 'react'
import type { ToneAsset } from '@shared/arsenal.js'
import { Select } from '../components/ui/Select.js'
import { IrAttributionNotice } from './IrAttributionNotice.js'

export function CabinetIrList({ assets, selected, disabled, onSelect, onImport }: {
  assets: ToneAsset[]; selected: string | null; disabled?: boolean
  onSelect(id: string): void; onImport?(): Promise<void>
}): React.JSX.Element {
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(80), [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState('all')
  const all = useMemo(() => assets.filter(a => a.kind === 'ir'), [assets])
  const matches = useMemo(() => all.filter(a => (source === 'all' || (source === 'bundled' ? a.bundled : !a.bundled)) && `${a.name} ${a.tags?.join(' ') ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [all, query, source])
  const current = all.find(a => a.id === selected)
  const importFiles = async (): Promise<void> => {
    if (!onImport || importing) return
    setImporting(true); setError('')
    try { await onImport(); setQuery(''); setSource('all'); setLimit(80) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setImporting(false) }
  }
  return <section className="cab-ir-library" aria-label="箱体 IR 列表">
    <div className="cab-ir-toolbar"><label>IR 列表 <small>{all.length}</small></label>
      <Select aria-label="IR 来源" value={source} onChange={e => { setSource(e.target.value); setLimit(80) }}><option value="all">全部</option><option value="bundled">内置</option><option value="user">已导入</option></Select>
      <input aria-label="搜索 IR" placeholder="搜索名称或标签" value={query} onChange={e => { setQuery(e.target.value); setLimit(80) }}/>
      {onImport && <button disabled={disabled || importing} onClick={() => void importFiles()}>{importing ? '导入中…' : '导入 IR'}</button>}
    </div>
    {selected && !all.some(a => a.id === selected) && <p role="alert">所选 IR 已缺失，请重新导入或选择。</p>}
    {error && <p role="alert">{error}</p>}
    <div className="cab-ir-rows">
      {matches.slice(0, limit).map(a => <button key={a.id} disabled={disabled} aria-pressed={a.id === selected} className="cab-ir-row" onClick={() => onSelect(a.id)}>
        <span className="cab-ir-name" title={a.name}>{a.name}</span><small>{a.bundled ? '内置' : '已导入'} · {a.sampleRate / 1000} kHz · {a.channels === 2 ? '立体声' : '单声道'} · {a.durationMs.toFixed(1)} ms</small><span aria-hidden="true">{a.id === selected ? '✓' : ''}</span>
      </button>)}
      {!matches.length && <p>{all.length ? '没有匹配的 IR' : '导入 WAV 箱体响应后，点击列表即可选用。'}</p>}
    </div>
    {matches.length > limit && <button onClick={() => setLimit(n => n + 80)}>显示更多（{matches.length - limit}）</button>}
    {current && <IrAttributionNotice asset={current}/>}
  </section>
}
