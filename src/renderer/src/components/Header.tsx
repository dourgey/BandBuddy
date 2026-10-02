import { Dumbbell, AudioLines, ClipboardList, Copy as RestoreIcon, Library, ListMusic, Minus, Music2, Settings, Square, X, PackageOpen } from 'lucide-react'
import { useEffect, useState } from 'react'

export function Header({
  view,
  onView,
  taskCount,
  onTasks,
  onSettings,
  locked = false,
  recording = false
}: {
  view: 'library' | 'practice' | 'woodshed' | 'rehearsal' | 'arsenal'
  onView(view: 'library' | 'practice' | 'woodshed' | 'rehearsal' | 'arsenal'): void
  taskCount: number
  onTasks(): void
  onSettings(): void
  locked?: boolean
  recording?: boolean
}): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let active = true
    void window.bandbuddy.window.isMaximized().then((value) => { if (active) setMaximized(value) })
    const unsubscribe = window.bandbuddy.window.onMaximizedChange(setMaximized)
    return () => { active = false; unsubscribe() }
  }, [])

  return <header className="titlebar">
    <div className="brand no-drag" onClick={() => { if (!locked) onView('library') }} role="button" aria-disabled={locked} onKeyDown={(event) => { if (!locked && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onView('library') } }} tabIndex={locked ? -1 : 0}>
      <span className="brand-mark"><AudioLines size={16} /></span>
      <span><b>BandBuddy</b><small>音乐练习伴侣</small></span>
    </div>
    <nav className="top-nav no-drag" aria-label="主导航" title={locked ? '录音进行中，请先停止并保存录音后切换页面' : undefined}>
      <button disabled={locked} className={view === 'library' ? 'active' : ''} onClick={() => onView('library')}><Library size={19} />曲库</button>
      <button disabled={locked} className={view === 'practice' ? 'active' : ''} onClick={() => onView('practice')}><Music2 size={20} />练习室</button>
      <button disabled={locked} className={view === 'woodshed' ? 'active' : ''} onClick={() => onView('woodshed')}><Dumbbell size={19} />练功房</button>
      <button disabled={locked} className={view === 'rehearsal' ? 'active' : ''} onClick={() => onView('rehearsal')}><ListMusic size={20} />排练房</button>
      <button disabled={locked} className={view === 'arsenal' ? 'active' : ''} onClick={() => onView('arsenal')}><PackageOpen size={19} />军火库</button>
    </nav>
    {recording && <span className="recording-navigation-note" role="status">录音中 · 可切页浏览</span>}
    <div className="title-actions no-drag">
      <button className="quiet-button" disabled={locked} onClick={onTasks}><ClipboardList size={18} />任务{taskCount > 0 && <i className="count-badge">{taskCount}</i>}</button>
      <span className="title-divider" />
      <button className="quiet-button" title={recording ? '外观设置 · 录音持续进行' : undefined} onClick={onSettings}><Settings size={18} />设置</button>
      <div className="window-controls">
        <button aria-label="最小化" onClick={() => void window.bandbuddy.window.minimize()}><Minus size={15} /></button>
        <button aria-label={maximized ? '还原' : '最大化'} onClick={() => void window.bandbuddy.window.toggleMaximize()}>{maximized ? <RestoreIcon size={12} /> : <Square size={12} />}</button>
        <button className="close" aria-label="关闭" onClick={() => void window.bandbuddy.window.close()}><X size={16} /></button>
      </div>
    </div>
  </header>
}
