import { Select } from '../components/ui/Select.js'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Clock3,
  Grid2X2,
  Heart,
  List,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  Search
} from 'lucide-react'
import { STEM_META, STEM_ORDER, type SongSummary } from '@shared/domain.js'
import { formatDate, formatTime, statusLabel } from '../utils.js'
import { Vinyl } from '../components/Vinyl.js'

const CARD_TEXT_SCROLL_SPEED = 32
const CARD_TEXT_SCROLL_HOLD_SECONDS = 1.6

function prepareCardTextScroll(event: React.MouseEvent<HTMLElement>): void {
  const container = event.currentTarget
  const content = container.firstElementChild
  if (!(content instanceof HTMLElement)) return

  const distance = Math.ceil(content.scrollWidth - container.clientWidth)
  if (distance <= 1) {
    container.dataset.overflow = 'false'
    container.style.removeProperty('--card-scroll-distance')
    container.style.removeProperty('--card-scroll-duration')
    return
  }

  const duration = Math.min(14, Math.max(2.8, distance / CARD_TEXT_SCROLL_SPEED + CARD_TEXT_SCROLL_HOLD_SECONDS))
  container.dataset.overflow = 'true'
  container.style.setProperty('--card-scroll-distance', `${distance}px`)
  container.style.setProperty('--card-scroll-duration', `${duration.toFixed(2)}s`)
}

export function LibraryPage({
  songs,
  loading,
  query,
  filter,
  layout,
  onQuery,
  onFilter,
  onLayout,
  onImport,
  onOpen,
  onPlay,
  onFavorite,
  onMenu,
  recentSongs, recentTotal, recentOffset = 0, onRecentPage,
  total, offset = 0, pageSize = 50, onPage, error, onRetry
}: {
  recentSongs?: SongSummary[]
  recentTotal?: number
  recentOffset?: number
  onRecentPage?(offset: number): void
  total?: number
  offset?: number
  pageSize?: number
  onPage?(offset: number): void
  error?: string
  onRetry?(): void
  songs: SongSummary[]
  loading: boolean
  query: string
  filter: 'all' | 'favorite' | 'processing' | 'recent'
  layout: 'list' | 'grid'
  onQuery(value: string): void
  onFilter(value: 'all' | 'favorite' | 'processing' | 'recent'): void
  onLayout(value: 'list' | 'grid'): void
  onImport(): void
  onOpen(song: SongSummary): void
  onPlay(song: SongSummary): void
  onFavorite(song: SongSummary): void
  onMenu(song: SongSummary): void
}): React.JSX.Element {
  const recent = recentSongs ?? songs.slice(0, 3)
  const resultTotal = total ?? songs.length
  const [search, setSearch] = useState(query)
  const [composing, setComposing] = useState(false)
  const [shortViewport, setShortViewport] = useState(() => window.innerHeight <= 600)
  const [recentPreference, setRecentPreference] = useState<boolean | null>(() => {
    try { const saved = localStorage.getItem('bandbuddy.library.recentExpanded'); return saved === 'true' ? true : saved === 'false' ? false : null } catch { return null }
  })
  const recentExpanded = recentPreference ?? !shortViewport
  const recentId = useId()
  const page = useRef<HTMLElement>(null)
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery
  useEffect(() => {
    const resize = (): void => setShortViewport(window.innerHeight <= 600)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => { if (page.current) page.current.scrollTop = 0 }, [offset, query, filter])
  useEffect(() => { setSearch(query) }, [query])
  useEffect(() => {
    if (composing || search === query) return
    const timer = window.setTimeout(() => onQueryRef.current(search), 150)
    return () => window.clearTimeout(timer)
  }, [search, query, composing])
  return <main ref={page} className="page library-page">
    <div className="library-decoration" aria-hidden><div className="record-lines" /><span>♩</span></div>
    <section className="library-hero">
      <div><h1>曲库</h1><p>管理你的歌曲，随时开启高效练习</p></div>
      <div className="library-tools">
        <label className="search-box"><Search size={20} /><input aria-label="搜索歌曲或艺术家" value={search} onChange={(event) => setSearch(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setSearch(event.currentTarget.value); setComposing(false) }} placeholder="搜索歌曲、艺术家…" /></label>
        <button className="primary-button" onClick={onImport}><Plus size={20} />导入歌曲</button>
      </div>
    </section>

    {recent.length > 0 && <section className={`recent-section ${recentExpanded ? '' : 'is-collapsed'}`}>
        <div className="section-heading"><h2><button className="recent-toggle" aria-label={`${recentExpanded ? '收起' : '展开'}最近练习`} aria-expanded={recentExpanded} aria-controls={recentExpanded ? recentId : undefined} onClick={() => { const next = !recentExpanded; setRecentPreference(next); try { localStorage.setItem('bandbuddy.library.recentExpanded', String(next)) } catch { /* Storage limits must not prevent expanding the list. */ } }}><Clock3 size={23} />最近练习{recentExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></h2>{recentExpanded && <span><button aria-label="上一组" disabled={recentOffset === 0 || !onRecentPage} onClick={() => onRecentPage?.(Math.max(0, recentOffset - 3))}><ChevronLeft /></button><button aria-label="下一组" disabled={!onRecentPage || recentOffset + 3 >= (recentTotal ?? recent.length)} onClick={() => onRecentPage?.(recentOffset + 3)}><ChevronRight /></button></span>}</div>
        {recentExpanded && <div id={recentId} className="recent-grid library-recent-strip">
          {recent.map((song) => <SongCard key={song.id} song={song} onOpen={() => onOpen(song)} onPlay={() => onPlay(song)} onMenu={() => onMenu(song)} />)}
        </div>}
      </section>}
      <section className="all-songs">
        <div className="section-heading all-heading">
          <div><h2><Music2 size={24} />{filter === 'all' ? '全部歌曲' : filter === 'favorite' ? '已收藏' : filter === 'processing' ? '处理中' : '最近练习'}</h2><small className="library-result-count">{resultTotal} 首</small>
            <Select value={filter} onChange={(event) => onFilter(event.target.value as typeof filter)} aria-label="筛选歌曲">
              <option value="all">全部状态</option><option value="favorite">已收藏</option><option value="processing">处理中</option><option value="recent">最近练习</option>
            </Select>
          </div>
          <span className="layout-toggle"><button aria-label="网格视图" aria-pressed={layout === 'grid'} className={layout === 'grid' ? 'active' : ''} onClick={() => onLayout('grid')}><Grid2X2 size={17} /></button><button aria-label="列表视图" aria-pressed={layout === 'list'} className={layout === 'list' ? 'active' : ''} onClick={() => onLayout('list')}><List size={18} /></button></span>
        </div>
        {error ? <div className="library-error" role="alert"><p>{error}</p><button className="outline-button" onClick={onRetry}>重试</button></div> : loading ? <LibrarySkeleton /> : songs.length === 0 ? (query || filter !== 'all' ? <p className="library-no-results" role="status">没有找到匹配的歌曲，试试其他关键词或筛选条件。</p> : <EmptyLibrary onImport={onImport} />) : layout === 'list' ? <SongTable key={`${query}:${filter}:${offset}`} songs={songs} rowOffset={offset} rowCount={resultTotal} layoutRevision={recentExpanded} onOpen={onOpen} onPlay={onPlay} onFavorite={onFavorite} onMenu={onMenu} /> : <div className="song-grid">{songs.map((song) => <SongCard key={song.id} song={song} onOpen={() => onOpen(song)} onPlay={() => onPlay(song)} onMenu={() => onMenu(song)} />)}</div>}
        <footer className="library-results-footer">
          <span role="status">{resultTotal && songs.length ? `${offset + 1}–${Math.min(offset + songs.length, resultTotal)} / ${resultTotal} 首` : '0 首歌曲'}</span>
          <nav className="library-pagination" aria-label="曲库分页">
            <button className="outline-button" aria-label="上一页" disabled={!onPage || offset === 0 || loading} onClick={() => onPage?.(Math.max(0, offset - pageSize))}><ChevronLeft size={16} />上一页</button>
            <span>{Math.floor(offset / pageSize) + 1} / {Math.max(1, Math.ceil(resultTotal / pageSize))}</span>
            <button className="outline-button" aria-label="下一页" disabled={!onPage || offset + pageSize >= resultTotal || loading} onClick={() => onPage?.(offset + pageSize)}>下一页<ChevronRight size={16} /></button>
          </nav>
        </footer>
      </section>
  </main>
}

function SongCard({ song, onOpen, onPlay, onMenu }: { song: SongSummary; onOpen(): void; onPlay(): void; onMenu(): void }): React.JSX.Element {
  const processing = song.status === 'processing' || song.status === 'queued' || song.status === 'blockedRuntime'
  const artist = song.artist || '未知艺术家'
  const phase = song.phase ?? '任务排队中'
  return <article className="song-card" onDoubleClick={onOpen}>
    <Vinyl artworkUrl={song.artworkUrl} size="medium" spinning={song.status === 'processing'} showFallbackText={false} />
    <div className="song-card-info">
      <button className="card-more" aria-label="歌曲菜单" onClick={(event) => { event.stopPropagation(); onMenu() }}><MoreHorizontal size={20} /></button>
      <h3 className="card-scroll-text" title={song.title} onMouseEnter={prepareCardTextScroll}><span>{song.title}</span></h3>
      <p className="card-scroll-text" title={artist} onMouseEnter={prepareCardTextScroll}><span>{artist}</span></p>
      <span className="duration"><Clock3 size={14} />{formatTime(song.durationMs)}</span>
      {processing ? <div className="card-progress">
        <b>{statusLabel(song.status)} <em>{Math.round(song.progress * 100)}%</em></b>
        <span><i style={{ width: `${song.progress * 100}%` }} /></span>
        <small className="card-scroll-text" title={phase} onMouseEnter={prepareCardTextScroll}><span>{phase}</span></small>
      </div> : <>
        <div className="stem-pills">{song.stemTypes.slice(0, 4).map((stem) => <i key={stem} style={{ '--pill': STEM_META[stem].color } as React.CSSProperties}>{song.stemNames?.[stem] || STEM_META[stem].shortLabel}</i>)}</div>
        <button className="continue-button" onClick={onPlay}><Play size={15} fill="currentColor" />继续练习</button>
      </>}
    </div>
  </article>
}

function SongTable({ songs, rowOffset, rowCount, layoutRevision, onOpen, onPlay, onFavorite, onMenu }: { songs: SongSummary[]; rowOffset: number; rowCount: number; layoutRevision: boolean; onOpen(song: SongSummary): void; onPlay(song: SongSummary): void; onFavorite(song: SongSummary): void; onMenu(song: SongSummary): void }): React.JSX.Element {
  const table = useRef<HTMLDivElement>(null)
  const [windowed, setWindowed] = useState({ start: 0, end: Math.min(12, songs.length), rowHeight: 56 })
  const [focused, setFocused] = useState(false)
  useLayoutEffect(() => {
    const element = table.current
    const scroller = element?.closest<HTMLElement>('.library-page')
    if (!element || !scroller) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const rowHeight = element.querySelector('.song-row')?.getBoundingClientRect().height || 56
      const headerHeight = element.querySelector('.song-table-head')?.getBoundingClientRect().height || 37
      const rowsTop = element.getBoundingClientRect().top + headerHeight
      const top = scroller.getBoundingClientRect().top
      const bottom = top + (scroller.clientHeight || Math.max(200, window.innerHeight - 60))
      const start = Math.max(0, Math.min(songs.length - 1, Math.floor((top - rowsTop) / rowHeight) - 4))
      const end = Math.min(songs.length, Math.max(start + 1, Math.ceil((bottom - rowsTop) / rowHeight) + 4))
      setWindowed(previous => previous.start === start && previous.end === end && previous.rowHeight === rowHeight ? previous : { start, end, rowHeight })
    }
    const schedule = (): void => { if (!frame) frame = window.requestAnimationFrame(measure) }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(scroller)
    observer?.observe(element)
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('bandbuddy:theme-changed', schedule)
    return () => { if (frame) window.cancelAnimationFrame(frame); observer?.disconnect(); scroller.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); document.removeEventListener('bandbuddy:theme-changed', schedule) }
  }, [songs.length, layoutRevision, focused])
  // A page is bounded to 50 rows. Keep it intact during keyboard traversal so Tab never skips a song.
  const start = focused ? 0 : windowed.start
  const end = focused ? songs.length : windowed.end
  return <div ref={table} className="song-table" role="table" aria-label="曲库歌曲" aria-rowcount={rowCount + 1} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    <div className="song-table-head" role="row" aria-rowindex={1}><span role="columnheader">歌曲</span><span role="columnheader">艺术家</span><span role="columnheader">时长</span><span role="columnheader">分轨</span><span role="columnheader">状态</span><span role="columnheader">最近练习</span><span role="columnheader" aria-label="操作" /></div>
    {start > 0 && <div className="song-window-spacer" aria-hidden="true" style={{ height: start * windowed.rowHeight }} />}
    {songs.slice(start, end).map((song, index) => <div className="song-row" role="row" aria-rowindex={rowOffset + start + index + 2} key={song.id} onDoubleClick={() => onOpen(song)}>
      <span role="cell" className="song-cell"><button aria-pressed={song.favorite} className={`heart ${song.favorite ? 'active' : ''}`} onClick={() => onFavorite(song)} aria-label="收藏"><Heart size={13} fill={song.favorite ? 'currentColor' : 'none'} /></button><Vinyl size="tiny" artworkUrl={song.artworkUrl} showFallbackText={false} /><b>{song.title}</b></span>
      <span role="cell">{song.artist || '—'}</span><span role="cell"><Clock3 size={14} />{formatTime(song.durationMs)}</span>
      <span role="cell" className="stem-pills compact">{song.stemTypes.length ? song.stemTypes.map((stem) => <i key={stem} style={{ '--pill': STEM_META[stem].color } as React.CSSProperties}>{song.stemNames?.[stem] || STEM_META[stem].shortLabel}</i>) : STEM_ORDER.slice(0, 4).map((stem) => <i key={stem}>{song.stemNames?.[stem] || STEM_META[stem].shortLabel}</i>)}</span>
      <span role="cell" className={`status-cell ${song.status}`}><CheckCircle2 size={16} />{statusLabel(song.status)}{song.status === 'processing' && ` ${Math.round(song.progress * 100)}%`}</span>
      <span role="cell">{formatDate(song.lastPracticedAt)}</span>
      <span role="cell" className="row-actions"><button aria-label={`播放 ${song.title}`} onClick={() => onPlay(song)}><Play size={15} fill="currentColor" /></button><button aria-label="歌曲菜单" onClick={() => onMenu(song)}><MoreHorizontal size={19} /></button></span>
    </div>)}
    {end < songs.length && <div className="song-window-spacer" aria-hidden="true" style={{ height: (songs.length - end) * windowed.rowHeight }} />}
  </div>
}

function EmptyLibrary({ onImport }: { onImport(): void }): React.JSX.Element {
  return <section className="empty-library">
    <div className="empty-record"><Vinyl size="large" showFallbackText={false} /><span><Music2 size={28} /></span></div>
    <h2>把第一首歌放进曲库</h2><p>导入歌曲后会一次生成基础六轨，以及木吉他、Lead 和 Rhythm 三条吉他细分轨。</p>
    <button className="primary-button" onClick={onImport}><Plus size={19} />导入歌曲</button>
    <small>所有音乐和分轨资源都保存在你的电脑上</small>
  </section>
}

function LibrarySkeleton(): React.JSX.Element {
  return <div className="library-skeleton">{Array.from({ length: 4 }, (_, index) => <div key={index}><i /><span /></div>)}</div>
}
