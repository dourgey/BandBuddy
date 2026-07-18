import { AudioLines, ClipboardList, Library, Minus, Music2, Settings, Square, X } from 'lucide-react'

export function Header({
  view,
  onView,
  taskCount,
  onTasks,
  onSettings
}: {
  view: 'library' | 'practice'
  onView(view: 'library' | 'practice'): void
  taskCount: number
  onTasks(): void
  onSettings(): void
}): React.JSX.Element {
  return <header className="titlebar">
    <div className="brand no-drag" onClick={() => onView('library')} role="button" tabIndex={0}>
      <span className="brand-mark"><AudioLines size={16} /></span>
      <span><b>BandBuddy</b><small>音乐练习伴侣</small></span>
    </div>
    <nav className="top-nav no-drag" aria-label="主导航">
      <button className={view === 'library' ? 'active' : ''} onClick={() => onView('library')}><Library size={19} />曲库</button>
      <button className={view === 'practice' ? 'active' : ''} onClick={() => onView('practice')}><Music2 size={20} />练习室</button>
    </nav>
    <div className="title-actions no-drag">
      <button className="quiet-button" onClick={onTasks}><ClipboardList size={18} />任务{taskCount > 0 && <i className="count-badge">{taskCount}</i>}</button>
      <span className="title-divider" />
      <button className="quiet-button" onClick={onSettings}><Settings size={18} />设置</button>
      <div className="window-controls">
        <button aria-label="最小化" onClick={() => void window.bandbuddy.window.minimize()}><Minus size={15} /></button>
        <button aria-label="最大化" onClick={() => void window.bandbuddy.window.toggleMaximize()}><Square size={12} /></button>
        <button className="close" aria-label="关闭" onClick={() => void window.bandbuddy.window.close()}><X size={16} /></button>
      </div>
    </div>
  </header>
}
