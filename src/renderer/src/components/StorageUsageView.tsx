import { useEffect, useState } from 'react'
import type { StorageUsage } from '@shared/storage.js'

const size = (bytes: number): string => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`
export function StorageUsageView(): React.JSX.Element {
  const [usage, setUsage] = useState<StorageUsage | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(true)
  useEffect(() => {
    let active = true; setBusy(true); setError('')
    void Promise.resolve().then(() => window.bandbuddy.settings.storageUsage()).then(value => { if (active) setUsage(value) }).catch(() => { if (active) setError('暂时无法统计存储占用') }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [refresh])
  return <div className="storage-usage" aria-live="polite">
    <div><b>当前存储占用 {usage ? size(usage.totalBytes) : '—'}</b><button className="outline-button" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{busy ? '正在统计…' : '刷新'}</button></div>
    {usage?.entries.map(entry => <span key={entry.label} title={entry.path}>{entry.label}<strong>{entry.incomplete ? '至少 ' : ''}{size(entry.bytes)}</strong></span>)}
    {usage?.freeBytes != null && <small>曲库所在磁盘可用 {size(usage.freeBytes)}</small>}
    {error && <small role="alert">{error}</small>}
  </div>
}
