import {
  CheckCircle2,
  ChevronLeft,
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
  onMenu
}: {
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
  const recent = songs.slice(0, 4)
  return <main className="page library-page">
    <div className="library-decoration" aria-hidden><div className="record-lines" /><span>♩</span></div>
    <section className="library-hero">
      <div><h1>曲库</h1><p>管理你的歌曲，随时开启高效练习</p></div>
      <div className="library-tools">
        <label className="search-box"><Search size={20} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索歌曲、艺术家或风格…" /></label>
        <button className="primary-button" onClick={onImport}><Plus size={20} />导入歌曲</button>
      </div>
    </section>

    {loading ? <LibrarySkeleton /> : songs.length === 0 ? <EmptyLibrary onImport={onImport} /> : <>
      <section className="recent-section">
        <div className="section-heading"><h2><Clock3 size={23} />最近练习</h2><span><button aria-label="上一组"><ChevronLeft /></button><button aria-label="下一组"><ChevronRight /></button></span></div>
        <div className="recent-grid">
          {recent.map((song) => <SongCard key={song.id} song={song} onOpen={() => onOpen(song)} onPlay={() => onPlay(song)} onMenu={() => onMenu(song)} />)}
        </div>
      </section>
      <div className="cable-divider"><i /></div>
      <section className="all-songs">
        <div className="section-heading all-heading">
          <div><h2><Music2 size={24} />全部歌曲</h2>
            <select value={filter} onChange={(event) => onFilter(event.target.value as typeof filter)} aria-label="筛选歌曲">
              <option value="all">全部状态</option><option value="favorite">已收藏</option><option value="processing">处理中</option><option value="recent">最近练习</option>
            </select>
          </div>
          <span className="layout-toggle"><button className={layout === 'grid' ? 'active' : ''} onClick={() => onLayout('grid')}><Grid2X2 size={17} /></button><button className={layout === 'list' ? 'active' : ''} onClick={() => onLayout('list')}><List size={18} /></button></span>
        </div>
        {layout === 'list' ? <SongTable songs={songs} onOpen={onOpen} onPlay={onPlay} onFavorite={onFavorite} onMenu={onMenu} /> : <div className="song-grid">{songs.map((song) => <SongCard key={song.id} song={song} onOpen={() => onOpen(song)} onPlay={() => onPlay(song)} onMenu={() => onMenu(song)} />)}</div>}
      </section>
    </>}
  </main>
}

function SongCard({ song, onOpen, onPlay, onMenu }: { song: SongSummary; onOpen(): void; onPlay(): void; onMenu(): void }): React.JSX.Element {
  const processing = song.status === 'processing' || song.status === 'queued' || song.status === 'blockedRuntime'
  return <article className="song-card" onDoubleClick={onOpen}>
    <Vinyl artworkUrl={song.artworkUrl} size="medium" spinning={song.status === 'processing'} showFallbackText={false} />
    <div className="song-card-info">
      <button className="card-more" aria-label="歌曲菜单" onClick={(event) => { event.stopPropagation(); onMenu() }}><MoreHorizontal size={20} /></button>
      <h3 title={song.title}>{song.title}</h3><p>{song.artist || '未知艺术家'}</p>
      <span className="duration"><Clock3 size={14} />{formatTime(song.durationMs)}</span>
      {processing ? <div className="card-progress">
        <b>{statusLabel(song.status)} <em>{Math.round(song.progress * 100)}%</em></b>
        <span><i style={{ width: `${song.progress * 100}%` }} /></span><small>{song.phase ?? '任务排队中'}</small>
      </div> : <>
        <div className="stem-pills">{song.stemTypes.slice(0, 4).map((stem) => <i key={stem} style={{ '--pill': STEM_META[stem].color } as React.CSSProperties}>{STEM_META[stem].shortLabel}</i>)}</div>
        <button className="continue-button" onClick={onPlay}><Play size={15} fill="currentColor" />继续练习</button>
      </>}
    </div>
  </article>
}

function SongTable({ songs, onOpen, onPlay, onFavorite, onMenu }: { songs: SongSummary[]; onOpen(song: SongSummary): void; onPlay(song: SongSummary): void; onFavorite(song: SongSummary): void; onMenu(song: SongSummary): void }): React.JSX.Element {
  return <div className="song-table" role="table">
    <div className="song-table-head" role="row"><span>歌曲</span><span>艺术家</span><span>时长</span><span>分轨</span><span>状态</span><span>最近练习</span><span /></div>
    {songs.map((song) => <div className="song-row" role="row" key={song.id} onDoubleClick={() => onOpen(song)}>
      <span className="song-cell"><button className={`heart ${song.favorite ? 'active' : ''}`} onClick={() => onFavorite(song)} aria-label="收藏"><Heart size={13} fill={song.favorite ? 'currentColor' : 'none'} /></button><Vinyl size="tiny" artworkUrl={song.artworkUrl} showFallbackText={false} /><b>{song.title}</b></span>
      <span>{song.artist || '—'}</span><span><Clock3 size={14} />{formatTime(song.durationMs)}</span>
      <span className="stem-pills compact">{song.stemTypes.length ? song.stemTypes.map((stem) => <i key={stem} style={{ '--pill': STEM_META[stem].color } as React.CSSProperties}>{STEM_META[stem].shortLabel}</i>) : STEM_ORDER.slice(0, 4).map((stem) => <i key={stem}>{STEM_META[stem].shortLabel}</i>)}</span>
      <span className={`status-cell ${song.status}`}><CheckCircle2 size={16} />{statusLabel(song.status)}{song.status === 'processing' && ` ${Math.round(song.progress * 100)}%`}</span>
      <span>{formatDate(song.lastPracticedAt)}</span>
      <span className="row-actions"><button onClick={() => onPlay(song)}><Play size={15} fill="currentColor" /></button><button aria-label="歌曲菜单" onClick={() => onMenu(song)}><MoreHorizontal size={19} /></button></span>
    </div>)}
  </div>
}

function EmptyLibrary({ onImport }: { onImport(): void }): React.JSX.Element {
  return <section className="empty-library">
    <div className="empty-record"><Vinyl size="large" showFallbackText={false} /><span><Music2 size={28} /></span></div>
    <h2>把第一首歌放进曲库</h2><p>导入歌曲后会在本机分离出 Vocal、Drums、Bass、Guitar、Piano 和 Other 六条音轨。</p>
    <button className="primary-button" onClick={onImport}><Plus size={19} />导入歌曲</button>
    <small>所有音乐和模型都保存在你的电脑上</small>
  </section>
}

function LibrarySkeleton(): React.JSX.Element {
  return <div className="library-skeleton">{Array.from({ length: 4 }, (_, index) => <div key={index}><i /><span /></div>)}</div>
}
