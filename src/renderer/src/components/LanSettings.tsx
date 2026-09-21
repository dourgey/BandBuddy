import { useEffect, useState } from 'react'
import { Copy, Wifi } from 'lucide-react'
import type { LanStatus } from '@shared/domain.js'

export function LanSettings(): React.JSX.Element {
  const [status, setStatus] = useState<LanStatus>({ enabled: false, port: null, urls: [], error: null })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    const refresh = (): void => { void window.bandbuddy.lan.status().then((value) => { if (active) setStatus(value) }).catch(() => { if (active) setMessage('无法读取局域网服务状态') }) }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy(true); setMessage('')
    try { setStatus(await window.bandbuddy.lan.setEnabled(enabled)) }
    catch (error) { setMessage(String(error)) }
    finally { setBusy(false) }
  }
  return <section className="settings-section"><h3><Wifi />局域网模式</h3>
    <label className="settings-toggle"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={(event) => void toggle(event.target.checked)} /><span><b>{busy ? '正在切换…' : '开启局域网练琴与同步'}</b><small>立即生效。同一网络的设备可练琴、下载分轨；退出 App 后自动关闭。</small></span></label>
    {status.enabled && <div className="lan-addresses"><p>在手机、iPad 或其他电脑浏览器打开以下地址（端口 {status.port}）。请保持此电脑与 App 运行。</p>{status.urls.map((url) => <div key={url}><input aria-label="局域网访问地址" readOnly value={url} onFocus={(event) => event.target.select()} /><button className="outline-button" aria-label="复制局域网地址" onClick={() => void navigator.clipboard.writeText(url).then(() => setMessage('地址已复制')).catch(() => setMessage('请选中地址手动复制'))}><Copy size={16} /></button></div>)}{!status.urls.length && <p>尚未检测到局域网地址，请连接 Wi-Fi 或网线后重试。</p>}<small>若无法访问，请确认设备在同一局域网，并允许系统防火墙接收 BandBuddy 的连接。移动端同步协议 v1 已启用。</small></div>}
    {(status.error || message) && <p role="status">{status.error || message}</p>}
  </section>
}
