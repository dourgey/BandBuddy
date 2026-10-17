import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, LoaderCircle, Monitor, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SystemInformationReport } from '@shared/environment.js'
import './system-information.css'

export function SystemInformationButton(): React.JSX.Element {
  const api = window.bandbuddy.environment
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<SystemInformationReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const refresh = async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true); setCopied(false); setCopying(false); setError(''); setReport(null)
    try {
      if (!api?.systemInformation) throw new Error('当前版本尚未提供系统信息接口，请重新启动更新后的应用。')
      const next = await api.systemInformation()
      if (current === generation.current) setReport(next)
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : '系统信息读取失败，请重试。')
    } finally { if (current === generation.current) setLoading(false) }
  }
  const changeOpen = (next: boolean): void => {
    setOpen(next)
    if (next) void refresh()
    else generation.current++
  }
  const copy = async (): Promise<void> => {
    if (!report || !api?.copySystemInformation) return
    const current = generation.current
    setCopying(true); setCopied(false); setError('')
    try {
      await api.copySystemInformation(report.id)
      if (current === generation.current) setCopied(true)
    } catch {
      if (current === generation.current) setError('复制失败，请重试；也可以展开“完整反馈文本”手动复制。')
    } finally { if (current === generation.current) setCopying(false) }
  }
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger className="outline-button system-information-trigger"><Monitor size={16} />系统与环境信息</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay system-information-overlay" data-dialog-open="true" />
      <Dialog.Content className="dialog-content system-information-dialog" data-dialog-open="true">
        <header className="system-information-header">
          <Dialog.Title>系统与环境信息</Dialog.Title>
          <Dialog.Description>查看软硬件和环境状态，一键复制用于问题反馈。本地路径与网络凭据已隐藏。</Dialog.Description>
        </header>
        <Dialog.Close className="dialog-close" aria-label="关闭系统与环境信息"><X /></Dialog.Close>
        <div className="system-information-scroll" aria-busy={loading}>
          {loading && <div className="system-information-loading" role="status"><LoaderCircle className="spin" size={22} /><span>正在读取系统信息…<small>个别设备响应较慢时，最多等待约 20 秒。</small></span></div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {report && <>
            <p className="system-information-time">采集时间：{new Date(report.collectedAt).toLocaleString()}<br />硬件按需读取；环境结果来自最近检测。此操作不会安装组件或打开麦克风。</p>
            {report.sections.map(section => <section className="system-information-section" key={section.title}>
              <h3>{section.title}</h3><dl>{section.rows.map((item, index) => <div key={`${item.label}:${index}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
            </section>)}
            <details className="system-information-text"><summary>完整反馈文本</summary><textarea aria-label="完整反馈文本" readOnly value={report.text} spellCheck={false} onFocus={event => event.currentTarget.select()} /></details>
          </>}
        </div>
        <footer className="system-information-footer">
          <span role="status">{copied ? '已复制，可直接粘贴反馈。' : report ? '复制内容与当前弹窗一致。' : '采集完成后可复制。'}</span>
          <div><button className="outline-button" disabled={loading || copying} onClick={() => void refresh()}><RefreshCw size={15} />刷新信息</button>
            <button className="primary-button" disabled={!report || loading || copying || !api?.copySystemInformation} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copying ? '正在复制…' : copied ? '已复制' : '一键复制'}</button></div>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
