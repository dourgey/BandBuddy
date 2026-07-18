export function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function gainLabel(db: number): string {
  if (db <= -60) return '−∞'
  const percent = Math.round(100 * 10 ** (db / 20))
  return `${db > 0 ? '+' : ''}${db.toFixed(db % 1 ? 1 : 0)} dB (${percent}%)`
}

export function statusLabel(status: string): string {
  return ({
    ready: '已完成', queued: '等待中', blockedRuntime: '等待环境', processing: '处理中',
    preparing: '准备中', separating: '分离中', postprocessing: '处理中', cancelling: '取消中',
    cancelled: '已取消', interrupted: '已中断', completed: '已完成', failed: '失败',
    missing: '未安装', detecting: '检测中', installing: '安装中', downloadingModel: '下载模型', verifying: '校验中'
  } as Record<string, string>)[status] ?? status
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
