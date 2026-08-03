import {
  ArrowLeft,
  Circle,
  Drum,
  GripVertical,
  Guitar,
  Mic2,
  MoreHorizontal,
  Pencil,
  Piano,
  Plus,
  Save,
  Sparkles,
  Square,
  Trash2,
  Upload
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  getStemTypeFromTrackOrderKey,
  moveTrackOrder,
  normalizeTrackOrder,
  STEM_META,
  type PracticeState,
  type RecordingMeter,
  type RecordingState,
  type RecordingTake,
  type RecordingTrackState,
  type SongDetail,
  type StemType,
  type TrackOrderKey,
  type TrackState
} from '@shared/domain.js'
import { Waveform } from '../components/Waveform.js'
import { clamp, gainLabel } from '../utils.js'

const icons: Record<StemType, typeof Mic2> = {
  vocals: Mic2,
  drums: Drum,
  bass: Guitar,
  guitar: Guitar,
  piano: Piano,
  other: Sparkles
}

interface PracticeRoomProps {
  song: SongDetail
  practice: PracticeState
  currentMs: number
  playing: boolean
  selectedStem: StemType
  recordingState: RecordingState
  recordingMeter: RecordingMeter
  locked: boolean
  backLabel?: string
  onBack(): void
  onSeek(milliseconds: number): void
  onPatch(patch: Partial<PracticeState>): void
  onTrack(stem: StemType, patch: Partial<TrackState>): void
  onSelected(stem: StemType): void
  onExport(): void
  onAddRecordingTrack(): void
  onEdit(): void
  onMore(): void
  onRecord(recordingTrackId: string): void
  onStopRecording(): void
  onCancelRecording(): void
  onSelectTake(recordingTrackId: string, takeId: string | null): void
  onUpdateTake(takeId: string, patch: { name?: string; alignmentOffsetMs?: number }): void
  onDeleteTake(takeId: string): void
  onRecordingTrack(
    recordingTrackId: string,
    patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): void
  onUseTakeSpeed(rate: number): void
}

export function PracticeRoom(props: PracticeRoomProps): React.JSX.Element {
  const {
    song, practice, currentMs, playing, selectedStem, recordingState, recordingMeter, locked, backLabel = '返回曲库',
    onBack, onSeek, onPatch, onTrack, onSelected, onExport, onAddRecordingTrack, onEdit, onMore, onRecord,
    onStopRecording, onCancelRecording, onSelectTake, onUpdateTake, onDeleteTake,
    onRecordingTrack, onUseTakeSpeed
  } = props
  const stems = new Map(song.stems.map((stem) => [stem.type, stem]))
  const recordingTracks = new Map(song.recordingTracks.map((track) => [track.id, track]))
  const trackOrder = normalizeTrackOrder(practice.trackOrder, song.recordingTracks.map((track) => track.id))
  const [draggedTrack, setDraggedTrack] = useState<TrackOrderKey | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: TrackOrderKey; placement: 'before' | 'after' } | null>(null)
  const draggedTrackRef = useRef<TrackOrderKey | null>(null)
  const dropTargetRef = useRef<{ key: TrackOrderKey; placement: 'before' | 'after' } | null>(null)
  const dragListenerCleanupRef = useRef<() => void>(() => undefined)

  const clearTrackDragListeners = (): void => {
    const cleanup = dragListenerCleanupRef.current
    dragListenerCleanupRef.current = () => undefined
    cleanup()
  }

  const finishTrackDrag = (): void => {
    clearTrackDragListeners()
    const dragged = draggedTrackRef.current
    const target = dropTargetRef.current
    if (dragged && target) {
      const nextOrder = moveTrackOrder(trackOrder, dragged, target.key, target.placement)
      if (nextOrder.some((key, index) => key !== trackOrder[index])) onPatch({ trackOrder: nextOrder })
    }
    draggedTrackRef.current = null
    dropTargetRef.current = null
    setDraggedTrack(null)
    setDropTarget(null)
  }

  const cancelTrackDrag = (): void => {
    clearTrackDragListeners()
    draggedTrackRef.current = null
    dropTargetRef.current = null
    setDraggedTrack(null)
    setDropTarget(null)
  }

  const updateTrackDragTarget = (target: { key: TrackOrderKey; placement: 'before' | 'after' }): void => {
    if (dropTargetRef.current?.key === target.key && dropTargetRef.current.placement === target.placement) return
    dropTargetRef.current = target
    setDropTarget(target)
  }

  const startTrackDrag = (key: TrackOrderKey): void => {
    clearTrackDragListeners()
    draggedTrackRef.current = key
    dropTargetRef.current = null
    setDraggedTrack(key)
    setDropTarget(null)

    const handlePointerMove = (event: PointerEvent): void => {
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.track-row')
      const targetKey = row?.dataset.trackOrderKey as TrackOrderKey | undefined
      if (!row || !targetKey || targetKey === key) return
      const bounds = row.getBoundingClientRect()
      updateTrackDragTarget({ key: targetKey, placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' })
    }
    const handlePointerUp = (): void => finishTrackDrag()
    const handlePointerCancel = (): void => cancelTrackDrag()
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    dragListenerCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }

  useEffect(() => () => clearTrackDragListeners(), [])

  const moveTrackWithKeyboard = (key: TrackOrderKey, direction: -1 | 1): void => {
    const index = trackOrder.indexOf(key)
    const target = trackOrder[index + direction]
    if (!target) return
    onPatch({ trackOrder: moveTrackOrder(trackOrder, key, target, direction < 0 ? 'before' : 'after') })
  }

  useEffect(() => {
    const recordingTimelineActive = ['countIn', 'armed', 'recording', 'stopping'].includes(recordingState.phase)
    if ((!playing && !recordingTimelineActive) || practice.zoom <= 1 || song.durationMs <= 0) return
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
  }, [currentMs, onPatch, playing, practice.scroll, practice.zoom, recordingState.phase, song.durationMs])

  return <main className="page practice-page">
    <section className="practice-heading">
      <button className="outline-button" onClick={onBack}><ArrowLeft size={17} />{backLabel}</button>
      <button className="outline-button" disabled={locked} onClick={onEdit}><Pencil size={16} />编辑信息</button>
      <button className="outline-button" disabled={locked} onClick={onExport}><Upload size={17} />导出</button>
      <button className="outline-button" disabled={locked} onClick={onAddRecordingTrack}><Plus size={17} />添加录音轨</button>
      <button className="outline-button" disabled={locked} onClick={onMore}><MoreHorizontal size={18} />更多</button>
    </section>

    <div className="practice-workspace">
      <section className="mixer-card">
        <div className="track-list">
          {trackOrder.map((key) => {
            const type = getStemTypeFromTrackOrderKey(key)
            const sharedDragProps = {
              trackKey: key,
              draggedTrack,
              dropTarget,
              onDragStart: startTrackDrag,
              onKeyboardMove: moveTrackWithKeyboard
            }
            if (type) {
              const stem = stems.get(type)
              const state = practice.tracks.find((track) => track.stemType === type)
                ?? { stemType: type, gainDb: 0, muted: false, solo: false }
              return <TrackRow
                key={key}
                {...sharedDragProps}
                type={type}
                state={state}
                exists={Boolean(stem)}
                selected={selectedStem === type}
                locked={locked}
                peaksUrl={stem?.peaksUrl ?? null}
                durationMs={song.durationMs}
                currentMs={currentMs}
                practice={practice}
                onSeek={onSeek}
                onRange={(start, end) => onPatch({ loopStartMs: start, loopEndMs: end, loopEnabled: true })}
                onPatch={(patch) => onTrack(type, patch)}
                onSelected={() => onSelected(type)}
                onViewChange={(zoom, scroll) => onPatch({ zoom, scroll })}
              />
            }
            const recordingTrack = recordingTracks.get(key.slice('recording:'.length))
            if (!recordingTrack) return null
            return <RecordingTrackRow
              key={key}
              {...sharedDragProps}
              song={song}
              recordingTrack={recordingTrack}
              takes={song.recordingTakes.filter((take) => take.recordingTrackId === recordingTrack.id)}
              practice={practice}
              currentMs={currentMs}
              state={recordingState}
              meter={recordingMeter}
              locked={locked}
              onRecord={() => onRecord(recordingTrack.id)}
              onStop={onStopRecording}
              onCancel={onCancelRecording}
              onSelectTake={(takeId) => onSelectTake(recordingTrack.id, takeId)}
              onUpdateTake={onUpdateTake}
              onDeleteTake={onDeleteTake}
              onTrack={(patch) => onRecordingTrack(recordingTrack.id, patch)}
              onUseTakeSpeed={onUseTakeSpeed}
              onSeek={onSeek}
              onRange={(start, end) => onPatch({ loopStartMs: start, loopEndMs: end, loopEnabled: true })}
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

interface TrackDragProps {
  trackKey: TrackOrderKey
  draggedTrack: TrackOrderKey | null
  dropTarget: { key: TrackOrderKey; placement: 'before' | 'after' } | null
  onDragStart(key: TrackOrderKey): void
  onKeyboardMove(key: TrackOrderKey, direction: -1 | 1): void
}

interface SortableTrackRowProps extends TrackDragProps {
  label: string
  className: string
  locked: boolean
  onClick?(): void
  children: React.ReactNode
}

function SortableTrackRow(props: SortableTrackRowProps): React.JSX.Element {
  const {
    trackKey, label, className, locked, draggedTrack, dropTarget,
    onDragStart, onKeyboardMove, onClick, children
  } = props
  const dragging = draggedTrack === trackKey
  const targetPlacement = dropTarget?.key === trackKey && draggedTrack !== trackKey ? dropTarget.placement : null

  return <div
    data-track-order-key={trackKey}
    className={`${className} ${dragging ? 'is-dragging' : ''} ${targetPlacement ? `drag-insert-${targetPlacement}` : ''}`}
    onClick={onClick}
  >
    <button
      type="button"
      className="track-drag-handle"
      disabled={locked}
      aria-label={`调整${label}的顺序`}
      aria-grabbed={dragging}
      title={locked ? '录音期间不能调整轨道顺序' : '拖动或按上下方向键调整轨道顺序'}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        event.stopPropagation()
        onKeyboardMove(trackKey, event.key === 'ArrowUp' ? -1 : 1)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        onDragStart(trackKey)
      }}
    ><GripVertical size={17} /></button>
    {children}
  </div>
}

interface TrackRowProps extends TrackDragProps {
  type: StemType
  state: TrackState
  exists: boolean
  selected: boolean
  locked: boolean
  peaksUrl: string | null
  durationMs: number
  currentMs: number
  practice: PracticeState
  onSeek(milliseconds: number): void
  onRange(start: number, end: number): void
  onPatch(patch: Partial<TrackState>): void
  onSelected(): void
  onViewChange(zoom: number, scroll: number): void
}

function TrackRow(props: TrackRowProps): React.JSX.Element {
  const {
    type, state, exists, selected, locked, peaksUrl, durationMs, currentMs, practice,
    onSeek, onRange, onPatch, onSelected, onViewChange, ...dragProps
  } = props
  const Icon = icons[type]
  return <SortableTrackRow
    {...dragProps}
    label={STEM_META[type].label}
    className={`track-row ${selected ? 'selected' : ''} ${exists ? '' : 'missing'}`}
    locked={locked}
    onClick={onSelected}
  >
    <span className="track-identity" style={{ '--track': STEM_META[type].color } as React.CSSProperties}>
      <i><Icon size={22} /></i><b>{STEM_META[type].shortLabel}</b>{!exists && <small>未导入</small>}
    </span>
    <span className="ms-buttons">
      <button className={state.muted ? 'active' : ''} disabled={!exists || locked} onClick={(event) => { event.stopPropagation(); onPatch({ muted: !state.muted }) }}>M</button>
      <button className={state.solo ? 'active' : ''} disabled={!exists || locked} onClick={(event) => { event.stopPropagation(); onPatch({ solo: !state.solo }) }}>S</button>
    </span>
    <span className="track-gain">
      <input disabled={!exists || locked} type="range" min="-60" max="6" step="0.5" value={state.gainDb} onDoubleClick={() => onPatch({ gainDb: 0 })} onChange={(event) => onPatch({ gainDb: Number(event.target.value) })} />
      <em>{gainLabel(state.gainDb)}</em>
    </span>
    <Waveform stemType={type} peaksUrl={peaksUrl} color={STEM_META[type].color} durationMs={durationMs} currentMs={currentMs} loopStartMs={practice.loopStartMs} loopEndMs={practice.loopEndMs} zoom={practice.zoom} scroll={practice.scroll} disabled={!exists || locked} onSeek={onSeek} onRange={onRange} onViewChange={onViewChange} />
  </SortableTrackRow>
}

interface RecordingTrackRowProps extends TrackDragProps {
  song: SongDetail
  recordingTrack: RecordingTrackState
  takes: RecordingTake[]
  practice: PracticeState
  currentMs: number
  state: RecordingState
  meter: RecordingMeter
  locked: boolean
  onRecord(): void
  onStop(): void
  onCancel(): void
  onSelectTake(takeId: string | null): void
  onUpdateTake(takeId: string, patch: { name?: string; alignmentOffsetMs?: number }): void
  onDeleteTake(takeId: string): void
  onTrack(patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>): void
  onUseTakeSpeed(rate: number): void
  onSeek(milliseconds: number): void
  onRange(start: number, end: number): void
  onViewChange(zoom: number, scroll: number): void
}

function RecordingTrackRow(props: RecordingTrackRowProps): React.JSX.Element {
  const {
    song, recordingTrack: track, takes, practice, currentMs, state, meter, locked, onRecord, onStop, onCancel, onSelectTake,
    onUpdateTake, onDeleteTake, onTrack, onUseTakeSpeed, onSeek, onRange, onViewChange, ...dragProps
  } = props
  const activeTake = takes.find((take) => take.id === track.activeTakeId) ?? null
  const speedMatches = !activeTake || Math.abs(activeTake.playbackRate - practice.playbackRate) < 0.0001
  const running = !['idle', 'failed'].includes(state.phase)
  const activeRunning = running && state.recordingTrackId === track.id
  const peak = activeRunning ? Math.max(...meter.peak, 0) : 0
  const renameTake = (take: RecordingTake): void => {
    const name = window.prompt('录音名称', take.name)?.trim()
    if (name && name !== take.name) onUpdateTake(take.id, { name })
  }

  return <SortableTrackRow
    {...dragProps}
    label={track.name}
    className={`track-row recording-track ${activeRunning ? 'is-recording' : ''}`}
    locked={locked}
  >
    <span className="track-identity recording-identity" style={{ '--track': '#b84f45' } as React.CSSProperties}>
      <i><Mic2 size={21} /></i><b>{track.name}</b>
      <span className="input-meter" title={`输入峰值 ${Math.round(peak * 100)}%`}><i style={{ width: `${Math.min(100, peak * 100)}%` }} /></span>
      {meter.clipped && <small className="clip-warning">CLIP</small>}
    </span>
    <span className="recording-actions">
      {!running
        ? <button className="record-button" aria-label={`在${track.name}开始录音`} onClick={onRecord}><Circle size={16} fill="currentColor" /></button>
        : activeRunning
          ? <><button className="stop-record-button" aria-label="停止并保存录音" onClick={onStop}><Square size={15} fill="currentColor" /></button><button aria-label="放弃录音" onClick={onCancel}>×</button></>
          : <button className="record-button" aria-label="其他录音轨正在录音" disabled><Circle size={16} /></button>}
    </span>
    <span className="ms-buttons">
      <button className={track.muted ? 'active' : ''} disabled={locked || !activeTake} onClick={() => onTrack({ muted: !track.muted, ...(!track.muted ? { solo: false } : {}) })}>M</button>
      <button className={track.solo ? 'active' : ''} disabled={locked || !activeTake} onClick={() => onTrack({ solo: !track.solo, ...(!track.solo ? { muted: false } : {}) })}>S</button>
    </span>
    <span className="track-gain">
      <input disabled={locked || !activeTake} type="range" min="-60" max="6" step="0.5" value={track.gainDb} onDoubleClick={() => onTrack({ gainDb: 0 })} onChange={(event) => onTrack({ gainDb: Number(event.target.value) })} />
      <em>{gainLabel(track.gainDb)}</em>
    </span>
    <div className="recording-wave-wrap">
      <Waveform
        stemType="recording"
        peaksUrl={activeTake?.peaksUrl ?? null}
        color="#b84f45"
        durationMs={song.durationMs}
        currentMs={currentMs}
        loopStartMs={practice.loopStartMs}
        loopEndMs={practice.loopEndMs}
        zoom={practice.zoom}
        scroll={practice.scroll}
        disabled={!activeTake || locked}
        live={activeRunning ? { sessionId: state.sessionId, active: true, meter } : undefined}
        onSeek={onSeek}
        onRange={onRange}
        onViewChange={onViewChange}
      />
      <div className="take-toolbar">
        <select value={activeTake?.id ?? ''} disabled={running || takes.length === 0} onChange={(event) => onSelectTake(event.target.value || null)}>
          <option value="">无活动 Take</option>
          {takes.map((take) => <option key={take.id} value={take.id}>{take.name} · {take.playbackRate.toFixed(2)}×{take.interrupted ? ' · 中断恢复' : ''}</option>)}
        </select>
        {activeTake && <>
          <button disabled={running} title="重命名" onClick={() => renameTake(activeTake)}><Pencil size={13} /></button>
          <button disabled={running} title="删除" onClick={() => onDeleteTake(activeTake.id)}><Trash2 size={13} /></button>
          {([-10, -1, 1, 10] as const).map((delta) => <button key={delta} disabled={running} onClick={() => onUpdateTake(activeTake.id, { alignmentOffsetMs: clamp(activeTake.alignmentOffsetMs + delta, -1000, 1000) })}>{delta > 0 ? '+' : ''}{delta} ms</button>)}
          <small>{activeTake.alignmentOffsetMs >= 0 ? '+' : ''}{activeTake.alignmentOffsetMs.toFixed(1)} ms</small>
        </>}
        {!speedMatches && activeTake && <button className="speed-mismatch" onClick={() => onUseTakeSpeed(activeTake.playbackRate)}>切回 {activeTake.playbackRate.toFixed(2)}×</button>}
        {activeRunning && <small className="recording-status">{state.message}{state.sampleRate > 0 ? ` · ${state.sampleRate} Hz · ${state.bufferFrames} f · ${state.latencyMs.toFixed(1)} ms` : ''}{state.xruns > 0 ? ` · xrun ${state.xruns}（可增大 buffer）` : ''}</small>}
      </div>
    </div>
  </SortableTrackRow>
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
