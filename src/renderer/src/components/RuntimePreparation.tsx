import { useState } from 'react'
import { Download, LoaderCircle, AlertTriangle } from 'lucide-react'
import type { RuntimeInfo } from '@shared/domain.js'
import { toUserErrorMessage } from '../utils.js'

export function RuntimePreparation({ runtime }: { runtime: RuntimeInfo }): React.JSX.Element | null {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (runtime.status === 'ready') return null
  const installing = ['installing', 'downloadingModel', 'verifying'].includes(runtime.status)
  const run = async (cancel = false): Promise<void> => {
    setError(''); setBusy(true)
    try { await (cancel ? window.bandbuddy.runtime.cancel() : window.bandbuddy.runtime.install()) }
    catch (reason) { setError(toUserErrorMessage(reason, '环境准备未完成，可以重试继续下载。')) }
    finally { setBusy(false) }
  }
  return <section className="bb-runtime-preparation" aria-label="准备分轨环境">
    <h3>{installing ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />} {installing ? '正在准备分轨环境' : '首次分轨，准备一次即可'}</h3>
    <p>自动下载 Python、分轨依赖和模型，建议预留 8–15 GB 空间。准备完成后可在本机离线分轨。</p>
    <small>曲库、已有音轨练习和其他功能现在即可使用。Windows 运行库可能需要系统授权。</small>
    <p role="status">{runtime.stage}</p>
    {runtime.progress !== null && <div className="progress-line" role="progressbar" aria-label="环境准备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(runtime.progress * 100)}><i style={{ width: `${runtime.progress * 100}%` }} /></div>}
    {(error || runtime.error) && <p className="form-error" role="alert"><AlertTriangle size={15} />{error || toUserErrorMessage(runtime.error!, '环境准备未完成，请重试。')}</p>}
    {installing ? <button className="outline-button" onClick={() => void run(true)}>取消准备</button> : <button className="primary-button" disabled={busy || runtime.status === 'detecting'} onClick={() => void run()}>{busy ? '正在准备…' : runtime.error ? '重试并继续准备' : '一键准备分轨环境'}</button>}
  </section>
}
