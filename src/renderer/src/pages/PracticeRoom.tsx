import {
  ArrowLeft,
  Drum,
  Guitar,
  Mic2,
  MoreHorizontal,
  Pencil,
  Piano,
  Save,
  Sparkles,
  Upload
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { STEM_META, STEM_ORDER, type PracticeState, type SongDetail, type StemType, type TrackState } from '@shared/domain.js'
import { clamp, gainLabel } from '../utils.js'
import { Waveform } from '../components/Waveform.js'

const icons: Record<StemType, typeof Mic2> = { vocals: Mic2, drums: Drum, bass: Guitar, guitar: Guitar, piano: Piano, other: Sparkles }

export function PracticeRoom({
  song,
  practice,
  currentMs,
  playing,
  selectedStem,
  onBack,
  onSeek,
  onPatch,
  onTrack,
  onSelected,
  onExport,
  onEdit,
  onMore
}: {
  song: SongDetail
  practice: PracticeState
  currentMs: number
  playing: boolean
  selectedStem: StemType
  onBack(): void
  onSeek(milliseconds: number): void
  onPatch(patch: Partial<PracticeState>): void
  onTrack(stem: StemType, patch: Partial<TrackState>): void
  onSelected(stem: StemType): void
  onExport(): void
  onEdit(): void
  onMore(): void
}): React.JSX.Element {
  const stems = new Map(song.stems.map((stem) => [stem.type, stem]))

  useEffect(() => {
    if (!playing || practice.zoom <= 1 || song.durationMs <= 0) return
    const span = 1 / practice.zoom
    const visibleStart = clamp(practice.scroll, 0, 1) * (1 - span)
    const position = clamp(currentMs / song.durationMs, 0, 1)
    let nextStart: number | null = null
    if (position > visibleStart + span) nextStart = position - span * 0.2
    else if (position < visibleStart) nextStart = position - span * 0.8
    if (nextStart !== null) {
      const boundedStart = clamp(nextStart, 0, 1 - span)
      onPatch({ scroll: boundedStart / (1 - span) })
    }
  }, [currentMs, onPatch, playing, practice.scroll, practice.zoom, song.durationMs])

  return <main className="page practice-page">
    <section className="practice-heading">
      <button className="outline-button" onClick={onBack}><ArrowLeft size={17} />返回曲库</button>
      <button className="outline-button" onClick={onEdit}><Pencil size={16} />编辑信息</button>
      <button className="outline-button" onClick={onExport}><Upload size={17} />导出</button>
      <button className="outline-button" onClick={onMore}><MoreHorizontal size={18} />更多</button>
    </section>

    <div className="practice-workspace">
      <section className="mixer-card">
        <div className="track-list">
          {STEM_ORDER.map((type) => {
            const stem = stems.get(type)
            const state = practice.tracks.find((track) => track.stemType === type) ?? { stemType: type, gainDb: 0, muted: false, solo: false }
            return <TrackRow
              key={type} type={type} state={state} exists={Boolean(stem)} selected={selectedStem === type}
              peaksUrl={stem?.peaksUrl ?? null} durationMs={song.durationMs} currentMs={currentMs}
              practice={practice} onSeek={onSeek} onRange={(start, end) => onPatch({ loopStartMs: start, loopEndMs: end, loopEnabled: true })}
              onPatch={(patch) => onTrack(type, patch)} onSelected={() => onSelected(type)}
              onViewChange={(zoom, scroll) => onPatch({ zoom, scroll })}
            />
          })}
        </div>
        <WaveformNavigator zoom={practice.zoom} scroll={practice.scroll} onScroll={(scroll) => onPatch({ scroll })} />
        <p className="piano-note"><Sparkles size={13} />Piano 是实验性分轨，复杂编曲中可能与 Guitar / Other 存在串音。</p>
      </section>
    </div>

    <div className="autosave"><Save size={13} />练习设置会自动保存</div>
  </main>
}

function TrackRow({
  type, state, exists, selected, peaksUrl, durationMs, currentMs, practice,
  onSeek, onRange, onPatch, onSelected, onViewChange
}: {
  type: StemType
  state: TrackState
  exists: boolean
  selected: boolean
  peaksUrl: string | null
  durationMs: number
  currentMs: number
  practice: PracticeState
  onSeek(milliseconds: number): void
  onRange(start: number, end: number): void
  onPatch(patch: Partial<TrackState>): void
  onSelected(): void
  onViewChange(zoom: number, scroll: number): void
}): React.JSX.Element {
  const Icon = icons[type]
  return <div className={`track-row ${selected ? 'selected' : ''} ${exists ? '' : 'missing'}`} onClick={onSelected}>
    <span className="track-identity" style={{ '--track': STEM_META[type].color } as React.CSSProperties}><i><Icon size={22} /></i><b>{STEM_META[type].shortLabel}</b>{!exists && <small>未导入</small>}</span>
    <span className="ms-buttons"><button className={state.muted ? 'active' : ''} disabled={!exists} onClick={(event) => { event.stopPropagation(); onPatch({ muted: !state.muted }) }}>M</button><button className={state.solo ? 'active' : ''} disabled={!exists} onClick={(event) => { event.stopPropagation(); onPatch({ solo: !state.solo }) }}>S</button></span>
    <span className="track-gain"><input disabled={!exists} type="range" min="-60" max="6" step="0.5" value={state.gainDb} onDoubleClick={() => onPatch({ gainDb: 0 })} onChange={(event) => onPatch({ gainDb: Number(event.target.value) })} /><em>{gainLabel(state.gainDb)}</em></span>
    <Waveform stemType={type} peaksUrl={peaksUrl} color={STEM_META[type].color} durationMs={durationMs} currentMs={currentMs} loopStartMs={practice.loopStartMs} loopEndMs={practice.loopEndMs} zoom={practice.zoom} scroll={practice.scroll} disabled={!exists} onSeek={onSeek} onRange={onRange} onViewChange={onViewChange} />
  </div>
}

function WaveformNavigator({ zoom, scroll, onScroll }: { zoom: number; scroll: number; onScroll(scroll: number): void }): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = element.current
    if (!viewport) return
    const maxScroll = viewport.scrollWidth - viewport.clientWidth
    const target = maxScroll * clamp(scroll, 0, 1)
    if (Math.abs(viewport.scrollLeft - target) > 1) viewport.scrollLeft = target
  }, [scroll, zoom])

  return <div
    ref={element}
    className={`waveform-navigator ${zoom <= 1 ? 'is-disabled' : ''}`}
    aria-label="波形图横向滚动"
    onScroll={(event) => {
      const viewport = event.currentTarget
      const maxScroll = viewport.scrollWidth - viewport.clientWidth
      const next = maxScroll > 0 ? viewport.scrollLeft / maxScroll : 0
      if (Math.abs(next - scroll) > 0.002) onScroll(next)
    }}
  ><i style={{ width: `${Math.max(100, zoom * 100)}%` }} /></div>
}
