import type { ToneAsset } from '@shared/arsenal.js'
import { useState } from 'react'

export function IrAttributionNotice({ asset }: { asset: ToneAsset }): React.JSX.Element | null {
  const [error, setError] = useState('')
  const a = asset.attribution
  if (!a) return null
  const open = (event: React.MouseEvent, link: 'source' | 'license'): void => {
    if (!asset.bundled) return
    event.preventDefault(); setError('')
    void window.bandbuddy.arsenal.command({ action: 'assetLink', id: asset.id, link }).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  return <details className="ir-attribution">
    <summary>来源与授权 · {a.author} · {a.license}</summary>
    <p>{a.credit}</p>
    <p><a href={a.sourceUrl} target="_blank" rel="noreferrer" onClick={e => open(e, 'source')}>原始发布</a> · <a href={a.licenseUrl} target="_blank" rel="noreferrer" onClick={e => open(e, 'license')}>{a.license}</a> · {a.changes}</p>
    {typeof asset.metadata.captureNotes === 'string' && <p>{asset.metadata.captureNotes}</p>}
    {error && <p role="alert">{error}</p>}
  </details>
}
