import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Pause, Play, Wrench } from 'lucide-react'
import type { EnvironmentState, EnvironmentAction } from '@shared/environment.js'
import './environment-status.css'

export const ENVIRONMENT_SETTINGS_EVENT = 'bandbuddy:environment-settings'
const labels: Record<EnvironmentAction, string> = { retry: '重试并继续', repair: '修复并继续', storage: '打开存储设置', network: '打开网络设置', audio: '检查音频设备', microphone: '打开麦克风设置', driver: '查看官方驱动', time: '打开日期与时间设置', security: '打开安全设置', restart: '请重启电脑后继续', repairApplication: '打开官方修复下载' }
const capabilities = { startup: '软件启动', media: '导入与导出', recording: '录音与监听', separation: '本地分轨', acceleration: '硬件加速' }
function size(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB` }
export function EnvironmentStatus({ compact = false, start = false }: { compact?: boolean; start?: boolean }): React.JSX.Element | null {
  const api = window.bandbuddy.environment
  const [state, setState] = useState<EnvironmentState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!api) return
    let mounted = true, changed = false
    const off = api.onChanged(value => { changed = true; if (mounted) setState(value) })
    void api.get().then(value => { if (mounted && !changed) setState(value) }).catch(() => {})
    const online = (): void => { if (start) void api.networkRestored().catch(() => {}) }
    window.addEventListener('online', online)
    if (navigator.onLine) online()
    const devicesChanged = (): void => { if (start) void api.devicesChanged?.().catch(() => {}) }
    if (start) navigator.mediaDevices?.addEventListener?.('devicechange', devicesChanged)
    return () => { mounted = false; off(); window.removeEventListener('online', online); if (start) navigator.mediaDevices?.removeEventListener?.('devicechange', devicesChanged) }
  }, [api, start])
  if (!api || !state || (compact && state.phase === 'ready')) return null
  const preparing = ['checking', 'preparing', 'waitingIdle'].includes(state.phase)
  const act = async (work: () => Promise<unknown>): Promise<void> => { setError(''); try { await work() } catch { setError('操作未完成，请重试或导出诊断信息。') } }
  const openAction = (action: EnvironmentAction): Promise<void> => {
    if (['storage', 'network', 'audio'].includes(action)) {
      window.dispatchEvent(new CustomEvent(ENVIRONMENT_SETTINGS_EVENT, { detail: action }))
      return Promise.resolve()
    }
    return api.openAction(action)
  }
  return <section className={`environment-status ${compact ? 'compact' : ''}`} aria-label="运行状态">
    <header>{state.phase === 'ready' ? <CheckCircle2 size={17} /> : preparing ? <Download size={17} /> : <AlertTriangle size={17} />}<strong>{state.phase === 'ready' ? '已就绪' : preparing ? '正在准备' : state.phase === 'paused' ? '已暂停' : '需要你处理'}</strong><span role="status">{state.message}</span></header>
    {state.totalBytes !== null && <small>{size(state.receivedBytes)} / {size(state.totalBytes)}</small>}
    {preparing && state.progress !== null && <progress aria-label="组件准备进度" max={1} value={state.progress} />}
    <div className="environment-actions">
      {preparing ? <button onClick={() => void act(() => api.pause())}><Pause size={14} />暂停</button> : state.phase !== 'ready' && <button onClick={() => void act(() => api.resume())}><Play size={14} />继续准备</button>}
      {!compact && <><button disabled={preparing} onClick={() => void act(() => api.repair())}><Wrench size={14} />一键修复</button><button onClick={() => void act(() => api.exportDiagnostics())}>导出诊断</button></>}
      {!compact && state.safeMode && <button onClick={() => void act(() => window.bandbuddy.startup?.recover?.(false) ?? Promise.resolve())}>恢复正常启动</button>}
      {state.issues.map(issue => issue.action !== 'restart' && <button key={issue.capability} onClick={() => void act(() => openAction(issue.action))}>{labels[issue.action]}</button>)}
    </div>
    {error && <p role="alert">{error}</p>}
    {!compact && <details><summary>功能状态与详细信息</summary><dl>{Object.entries(state.capabilities).map(([key, value]) => <div key={key}><dt>{capabilities[key as keyof typeof capabilities]}</dt><dd>{value === 'ready' ? '可用' : value === 'unchecked' ? '尚未检查' : key === 'acceleration' && state.capabilities.separation === 'ready' ? '使用兼容处理' : '尚未就绪'}</dd></div>)}</dl>{state.issues.map(issue => <p key={issue.capability}>{issue.message} <code>{issue.code}</code></p>)}</details>}
  </section>
}
