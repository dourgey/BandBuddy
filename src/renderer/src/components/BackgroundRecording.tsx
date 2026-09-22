import { ArrowRight, Mic2, Pause, Play, Square, X } from 'lucide-react'
import { useState } from 'react'
import { useRecordingSession, type RecordingOwner } from '../recording-session.js'
export function BackgroundRecording({ view, onReturn }: { view: string; onReturn(owner: RecordingOwner): void }): React.JSX.Element | null {
  const session = useRecordingSession()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  if (!session) return null
  const origin = session.owner === 'practice' ? '练习室' : '排练房'
  const transition = ['starting', 'preparing', 'stopping', 'finalizing'].includes(session.phase)
  const run = async (action?: () => Promise<void> | void): Promise<void> => {
    if (!action || pending) return
    setPending(true); setError('')
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : '录音操作失败，请重试') }
    finally { setPending(false) }
  }
  return <aside className="background-recording" aria-label="全局录音控制">
    <Mic2 size={18} /><span><b>{origin} · {session.phase === 'paused' ? '录音已暂停' : ['stopping', 'finalizing'].includes(session.phase) ? '正在保存录音' : transition ? '正在准备录音' : '正在录音'}</b><small>{session.message || '可浏览和搜索；播放、换曲与音频配置暂时锁定'}</small></span>
    {session.controls?.pause && session.controls.resume && <button className="outline-button compact" disabled={pending || transition} onClick={() => void run(session.phase === 'paused' ? session.controls?.resume : session.controls?.pause)}>{session.phase === 'paused' ? <Play size={15} /> : <Pause size={15} />}{session.phase === 'paused' ? '继续录音' : '暂停录音'}</button>}
    <button className="outline-button compact" disabled={pending || transition || !session.controls} onClick={() => void run(session.controls?.stop)}><Square size={15} />停止并保存录音</button>
    <button className="outline-button compact" disabled={pending || ['stopping', 'finalizing'].includes(session.phase) || !session.controls} onClick={() => void run(session.controls?.cancel)}><X size={15} />放弃录音</button>
    {view !== session.owner && <button className="outline-button compact" onClick={() => onReturn(session.owner)}>返回{origin}<ArrowRight size={15} /></button>}
    {error && <small role="alert">{error}</small>}
  </aside>
}
