import { useState } from 'react'
import type { DiagnosticReport, DiagnosticScope, EnvironmentIssue } from '@shared/environment.js'
import './environment-status.css'

export const capabilityLabels = { startup: '软件启动', media: '导入与导出', recording: '录音与监听', separation: '本地分轨', acceleration: '硬件加速' }
export function IssueDetails({ issue }: { issue: EnvironmentIssue }): React.JSX.Element {
  return <div className="diagnostic-issue">
    <b>{(issue.affectedCapabilities ?? [issue.capability]).map(key => capabilityLabels[key]).join('、')} · {issue.stage ?? '检测与准备'}</b>
    <p>{issue.resolvedAt ? '已解决 · ' : ''}{issue.message}</p>
    <small>{issue.confidence === 'confirmed' ? '已确认当前失败' : issue.confidence === 'suspected' ? '可能原因，仍需核实' : '原因待确认'} · {issue.code}</small>
    {!!issue.attempts?.length && <p>已尝试：{issue.attempts.map(item => `${item.action}（${item.result}）`).join('；')}</p>}
    {!!issue.nextSteps?.length && <ol>{issue.nextSteps.map(step => <li key={step}>{step}</li>)}</ol>}
    <details><summary>查看检测证据</summary><small>诊断编号：{issue.diagnosticId ?? '旧版记录'}</small><pre>{JSON.stringify(issue.evidence ?? { message: issue.message }, null, 2)}</pre></details>
  </div>
}

export function DiagnosticDetails({ scope }: { scope: DiagnosticScope }): React.JSX.Element | null {
  const api = window.bandbuddy.environment
  const [report, setReport] = useState<DiagnosticReport | null>(null)
  const [message, setMessage] = useState('')
  const act = async (work: () => Promise<unknown>, success = ''): Promise<void> => {
    try { await work(); setMessage(success) } catch { setMessage('诊断操作未完成，可重新尝试。') }
  }
  if (!api?.diagnostics) return null
  return <div className="diagnostic-details">
    <div className="environment-actions">
      <button onClick={() => void act(async () => setReport(await api.diagnostics!(scope)))}>查看故障详情</button>
      <button onClick={() => void act(() => api.copyDiagnostics!(scope), '问题摘要已复制')}>复制问题摘要</button>
      <button onClick={() => void act(() => api.exportDiagnostics(scope))}>导出诊断</button>
    </div>
    {message && <p role="status">{message}</p>}
    {report?.issues.map(issue => <IssueDetails key={issue.diagnosticId} issue={issue} />)}
    {report && !report.issues.length && <p>没有关联到详细诊断，可查看任务原始错误后重新尝试。</p>}
    {report?.persistenceError && <p role="alert">诊断暂时无法写入磁盘，仍可复制本次内存中的摘要。</p>}
    {!!report?.events.length && <details><summary>诊断时间线（{report.events.length} 条）</summary><ol>{report.events.map(event => <li key={event.id}>{new Date(event.at).toLocaleTimeString()} · {event.stage} · {event.result}</li>)}</ol></details>}
  </div>
}
