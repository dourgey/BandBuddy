import { RecordingEffects } from '../arsenal/RecordingEffects.js'
import { TrackMeter } from '../components/TrackMeter.js'
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
  Sparkles,
  Square,
  Upload
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import {
  getStemTypeFromTrackOrderKey,
  isStemVisible,
  moveTrackOrder,
  normalizeTrackOrder,
  STEM_META,
  transposeMusicalKey,
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
import { usePlayerStore, useRecordingMeterStore } from '../player-store.js'
import { SelectMenu } from '../components/SelectMenu.js'
import { Waveform } from '../components/Waveform.js'
import { VolumeControl } from '../components/VolumeControl.js'
import { clamp, isImpliedMuted, isSilenced, silenceToggle } from '../utils.js'
import { practiceMix } from '@shared/practice-mix.js'
import '../vocal-split.css'

const icons: Record<StemType, typeof Mic2> = {
  vocals: Mic2,
  lead_vocals: Mic2,
  backing_vocals: Mic2,
  drums: Drum,
  bass: Guitar,
  guitar: Guitar,
  acoustic_guitar: Guitar,
  lead_guitar: Guitar,
  rhythm_guitar: Guitar,
  piano: Piano,
  other: Sparkles
}

interface PracticeRoomProps {
  song: SongDetail
  practice: PracticeState
  currentMs?: number
  playing: boolean
  selectedStem: StemType
  availableOutputChannelPairs: number
  outputLatencyMs?: number
  recordingState: RecordingState
  recordingMeter?: RecordingMeter
  locked: boolean
  guitarSplitPending?: boolean
  guitarSplitReady?: boolean
  vocalSplitPending?: boolean
  vocalSplitStatus?: string
  onVocalAction?(action: 'removeLead' | 'soloBacking'): void
  backLabel?: string
  onBack(): void
  onSeek(milliseconds: number): void
  onTogglePlayback(): void
  onRestart(): void
  onCycleLoop(): void
  onPatch(patch: Partial<PracticeState>): void
  onGuitarSplit(enabled: boolean): void
  onVocalSplit(enabled: boolean): void
  onDismissGuitarSplitReady?(): void
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
  onDeleteRecordingTrack?(trackId: string): void
  onEffectsChanged?(): void
  onDeleteTake(takeId: string): void
  onRecordingTrack(
    recordingTrackId: string,
    patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): void
  onUseTakePractice(rate: number, pitchSemitones: number): void
}

export function PracticeRoom(props: PracticeRoomProps): React.JSX.Element {
  const {
    song, practice, currentMs, playing, selectedStem, availableOutputChannelPairs,
    recordingState, recordingMeter, locked, guitarSplitPending = false, guitarSplitReady = false,
    vocalSplitPending = song.vocalSplitStatus === 'pending', backLabel = '返回曲库',
    onBack, onSeek, onPatch, onGuitarSplit, onVocalSplit, onTrack, onSelected, onExport, onAddRecordingTrack, onEdit, onMore, onRecord,
    onStopRecording, onCancelRecording, onSelectTake, onUpdateTake, onDeleteTake,
    onRecordingTrack, onUseTakePractice, onTogglePlayback, onRestart, onCycleLoop,
    onDismissGuitarSplitReady, outputLatencyMs = 0
  } = props
  const stems = new Map(song.stems.map((stem) => [stem.type, stem]))
  const recordingTracks = new Map(song.recordingTracks.map((track) => [track.id, track]))
  const trackOrder = normalizeTrackOrder(practice.trackOrder, song.recordingTracks.map((track) => track.id))
  const visibleTrackOrder = trackOrder.filter((key) => {
    const stemType = getStemTypeFromTrackOrderKey(key)
    return stemType === null || (song.sourceFormat === 'existing-stems' ? stems.has(stemType) : isStemVisible(stemType, practice.guitarSplitEnabled, practice.vocalSplitEnabled))
  })
  const soloActive = practiceMix(song, practice).solo
  const toggleMute = (
    track: Pick<TrackState, 'muted' | 'gainDb' | 'solo'>,
    update: (patch: Partial<Pick<TrackState, 'muted' | 'gainDb' | 'solo'>>) => void
  ): void => {
    const restore = isSilenced(track) || isImpliedMuted(track, soloActive)
    // Join the audible solo group without releasing the other tracks' implied mutes.
    update({
      ...silenceToggle(restore ? { ...track, muted: true } : track),
      ...(restore && soloActive ? { solo: true } : {})
    })
  }
  const [draggedTrack, setDraggedTrack] = useState<TrackOrderKey | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: TrackOrderKey; placement: 'before' | 'after' } | null>(null)
  const draggedTrackRef = useRef<TrackOrderKey | null>(null)
  const dropTargetRef = useRef<{ key: TrackOrderKey; placement: 'before' | 'after' } | null>(null)
  const dragListenerCleanupRef = useRef<() => void>(() => undefined)
  const trackListRef = useRef<HTMLDivElement>(null)
  const dragAnimationOriginRef = useRef(new Map<TrackOrderKey, DOMRect>())
  const previewTrackOrder = draggedTrack && dropTarget
    ? moveTrackOrder(trackOrder, draggedTrack, dropTarget.key, dropTarget.placement)
    : trackOrder
  const renderedVisibleTrackOrder = previewTrackOrder.filter((key) => {
    const stemType = getStemTypeFromTrackOrderKey(key)
    return stemType === null || (song.sourceFormat === 'existing-stems' ? stems.has(stemType) : isStemVisible(stemType, practice.guitarSplitEnabled, practice.vocalSplitEnabled))
  })

  const captureTrackPositions = (): void => {
    const next = new Map<TrackOrderKey, DOMRect>()
    trackListRef.current?.querySelectorAll<HTMLElement>('[data-track-order-key]').forEach((row) => {
      next.set(row.dataset.trackOrderKey as TrackOrderKey, row.getBoundingClientRect())
    })
    dragAnimationOriginRef.current = next
  }

  useLayoutEffect(() => {
    if (dragAnimationOriginRef.current.size === 0) return
    trackListRef.current?.querySelectorAll<HTMLElement>('[data-track-order-key]').forEach((row) => {
      const key = row.dataset.trackOrderKey as TrackOrderKey
      const before = dragAnimationOriginRef.current.get(key)
      if (!before || typeof row.animate !== 'function') return
      const after = row.getBoundingClientRect()
      const offset = before.top - after.top
      if (Math.abs(offset) > 0.5) row.animate(
        [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
        { duration: 210, easing: 'cubic-bezier(.2,.78,.25,1)' }
      )
    })
    dragAnimationOriginRef.current.clear()
  }, [renderedVisibleTrackOrder.map((key) => key).join('|')])

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
    captureTrackPositions()
    draggedTrackRef.current = null
    dropTargetRef.current = null
    setDraggedTrack(null)
    setDropTarget(null)
  }

  const updateTrackDragTarget = (target: { key: TrackOrderKey; placement: 'before' | 'after' }): void => {
    if (dropTargetRef.current?.key === target.key && dropTargetRef.current.placement === target.placement) return
    captureTrackPositions()
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
    const index = visibleTrackOrder.indexOf(key)
    const target = visibleTrackOrder[index + direction]
    if (!target) return
    onPatch({ trackOrder: moveTrackOrder(trackOrder, key, target, direction < 0 ? 'before' : 'after') })
  }

  useEffect(() => {
    const recordingTimelineActive = ['countIn', 'armed', 'recording', 'stopping'].includes(recordingState.phase)
    if ((!playing && !recordingTimelineActive) || practice.zoom <= 1 || song.durationMs <= 0) return
    const span = 1 / practice.zoom
    const visibleStart = clamp(practice.scroll, 0, 1) * (1 - span)
    const follow = (positionMs: number): void => {
    const position = clamp(positionMs / song.durationMs, 0, 1)
    let nextStart: number | null = null
    if (position > visibleStart + span) nextStart = position - span * 0.2
    else if (position < visibleStart) nextStart = position - span * 0.8
    if (nextStart !== null) {
      const boundedStart = clamp(nextStart, 0, 1 - span)
      onPatch({ scroll: boundedStart / (1 - span) })
    }
    }
    follow(currentMs ?? usePlayerStore.getState().currentMs)
    if (currentMs !== undefined) return
    return usePlayerStore.subscribe((state, previous) => { if (state.currentMs !== previous.currentMs) follow(state.currentMs) })
  }, [currentMs, onPatch, playing, practice.scroll, practice.zoom, recordingState.phase, song.durationMs])

  return <main className="page practice-page">
    <div className="practice-song-caption"><b>{song.title}</b><span>{song.artist || '未知艺术家'}</span></div>
    <section className="practice-heading">
      <button className="outline-button" onClick={onBack}><ArrowLeft size={17} />{backLabel}</button>
      <button className="outline-button" disabled={locked} onClick={onEdit}><Pencil size={16} />编辑信息</button>
      <button className="outline-button" disabled={locked} onClick={onExport}><Upload size={17} />导出</button>
      <button className="outline-button" disabled={locked} onClick={onAddRecordingTrack}><Plus size={17} />添加录音轨</button>
      <div className="guitar-split-control">
        <button
          className={`outline-button ${practice.guitarSplitEnabled ? 'active' : ''}`}
          disabled={locked || guitarSplitPending || song.sourceFormat === 'existing-stems'}
          aria-pressed={practice.guitarSplitEnabled}
          aria-describedby={guitarSplitPending ? `guitar-split-wait-${song.id}` : undefined}
          onClick={() => onGuitarSplit(!practice.guitarSplitEnabled)}
        ><Guitar size={17} />吉他分轨</button>
        {guitarSplitPending && <span id={`guitar-split-wait-${song.id}`} className="guitar-split-tooltip" role="tooltip">
          正在分轨中，请耐心等待
        </span>}
        {guitarSplitReady && <aside className="guitar-split-ready" role="status">
          <span><b>吉他分轨已完成</b><small>现在可以切换木吉他、Lead 和 Rhythm</small></span>
          <button aria-label="关闭吉他分轨完成提示" onClick={onDismissGuitarSplitReady}>×</button>
        </aside>}
      </div>
      <div className="vocal-split-control">
        <button
          className={`outline-button ${practice.vocalSplitEnabled ? 'active' : ''}`}
          disabled={locked || vocalSplitPending || song.sourceFormat === 'existing-stems'}
          aria-pressed={practice.vocalSplitEnabled}
          aria-describedby={vocalSplitPending ? `vocal-split-wait-${song.id}` : undefined}
          title={practice.vocalSplitEnabled ? '恢复完整人声' : song.vocalSplitStatus === 'failed' ? '重试主唱与和声分离' : '区分主唱和和声'}
          onClick={() => onVocalSplit(!practice.vocalSplitEnabled)}
        ><Mic2 size={17} />人声分轨</button>
        {vocalSplitPending && <span id={`vocal-split-wait-${song.id}`} className="vocal-split-tooltip" role="tooltip">
          {props.vocalSplitStatus || '正在细分主唱与和声，请耐心等待'}
        </span>}
      </div>
      <button className="outline-button" disabled={locked} onClick={onMore}><MoreHorizontal size={18} />更多</button>
      {song.musicalKey && <div className="practice-key-badge"><Sparkles size={15} /><span><b>{practice.pitchSemitones === 0 ? song.musicalKey : `${song.musicalKey} → ${transposeMusicalKey(song.musicalKey, practice.pitchSemitones)}`}</b><small>{song.musicalKeySource === 'manual' ? '手动纠正' : song.keyAnalysis ? `识别 ${Math.round(song.keyAnalysis.confidence * 100)}%` : '歌曲调'}{song.keyAnalysis?.segments.some((segment) => segment.possibleModulation) ? ` · 可能转调 ${song.keyAnalysis.segments.filter((segment) => segment.possibleModulation).length} 处` : ''}</small></span></div>}
    </section>

    <div className="practice-workspace">
      <section className="mixer-card">
        <div className="track-list" ref={trackListRef}>
          <SharedPlayhead durationMs={song.durationMs} currentMs={currentMs} zoom={practice.zoom} scroll={practice.scroll} />
          {renderedVisibleTrackOrder.map((key) => {
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
                ?? { stemType: type, gainDb: 0, muted: false, solo: false, outputChannelPair: 1 }
              return <TrackRow
                key={key}
                {...sharedDragProps}
                type={type}
                name={stem?.name ?? undefined}
                state={state}
                exists={Boolean(stem)}
                showWaveform={true}
                selected={selectedStem === type}
                soloActive={soloActive}
                locked={locked}
                availableOutputChannelPairs={availableOutputChannelPairs}
                peaksUrl={stem?.peaksUrl ?? null}
                durationMs={song.durationMs}
                currentMs={currentMs}
                practice={practice}
                onSeek={onSeek}
                onRange={(start, end) => onPatch({ loopStartMs: start, loopEndMs: end, loopEnabled: true })}
                onPatch={(patch) => onTrack(type, patch)}
                onToggleMute={() => toggleMute(state, (patch) => {
                  // S selects an exclusive solo; M adds this track to the existing group.
                  if (patch.solo) onPatch({ tracks: practice.tracks.map((track) => track.stemType === type ? { ...track, ...patch } : track) })
                  else onTrack(type, patch)
                })}
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
              soloActive={soloActive}
              locked={locked}
              onRecord={() => onRecord(recordingTrack.id)}
              onStop={onStopRecording}
              onCancel={onCancelRecording}
              onSelectTake={(takeId) => onSelectTake(recordingTrack.id, takeId)}
              onUpdateTake={onUpdateTake}
              onDeleteTrack={() => props.onDeleteRecordingTrack?.(recordingTrack.id)}
              onEffectsChanged={props.onEffectsChanged}
              onDeleteTake={onDeleteTake}
              onTrack={(patch) => onRecordingTrack(recordingTrack.id, patch)}
              onToggleMute={() => toggleMute(recordingTrack, (patch) => onRecordingTrack(recordingTrack.id, {
                ...patch, ...(patch.muted ? { solo: false } : {})
              }))}
              onUseTakePractice={onUseTakePractice}
              onSeek={onSeek}
              onRange={(start, end) => onPatch({ loopStartMs: start, loopEndMs: end, loopEnabled: true })}
              onViewChange={(zoom, scroll) => onPatch({ zoom, scroll })}
            />
          })}
        </div>
        {<WaveformNavigator zoom={practice.zoom} scroll={practice.scroll} onScroll={(scroll) => onPatch({ scroll })} />}
        {availableOutputChannelPairs > 1 && <p className="routing-note">多通道输出已启用 · 节拍器与录音预听固定到 1–2</p>}
      </section>
    </div>

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

function TrackGainControl({ label, value, disabled, onChange }: {
  label: string
  value: number
  disabled: boolean
  onChange(value: number): void
}): React.JSX.Element {
  return <VolumeControl label={label.replace('电平', '音量')} value={value} disabled={disabled} onChange={onChange} />
}

interface TrackRowProps extends TrackDragProps {
  name?: string
  type: StemType
  state: TrackState
  exists: boolean
  showWaveform: boolean
  selected: boolean
  soloActive: boolean
  locked: boolean
  availableOutputChannelPairs: number
  peaksUrl: string | null
  durationMs: number
  currentMs?: number
  practice: PracticeState
  onSeek(milliseconds: number): void
  onRange(start: number, end: number): void
  onPatch(patch: Partial<TrackState>): void
  onToggleMute(): void
  onSelected(): void
  onViewChange(zoom: number, scroll: number): void
}

function TrackRow(props: TrackRowProps): React.JSX.Element {
  const {
    type, name, state, exists, showWaveform, selected, soloActive, locked, availableOutputChannelPairs,
    peaksUrl, durationMs, currentMs, practice,
    onSeek, onRange, onPatch, onToggleMute, onSelected, onViewChange, ...dragProps
  } = props
  const Icon = icons[type]
  const outputPairs = Array.from(
    { length: Math.max(1, availableOutputChannelPairs) },
    (_, index) => index * 2 + 1
  )
  const selectedPair = state.outputChannelPair ?? 1
  const selectedPairAvailable = outputPairs.includes(selectedPair)
  return <SortableTrackRow
    {...dragProps}
    label={name || STEM_META[type].label}
    className={`track-row ${selected ? 'selected' : ''} ${exists ? '' : 'missing'}`}
    locked={locked}
    onClick={onSelected}
  >
    <span className="track-identity" style={{ '--track': STEM_META[type].color } as React.CSSProperties}>
      <i><Icon size={22} /></i><TrackName name={state.name || name || STEM_META[type].shortLabel} disabled={locked} onChange={name => onPatch({ name })} />{!exists && <small>未导入</small>}
    </span>
    <div className="track-controls"><span className="ms-buttons">
      <button title="静音 (M)" aria-label={`${name || STEM_META[type].label}静音`} className={isSilenced(state) ? 'active' : isImpliedMuted(state, soloActive && exists) ? 'is-implied-muted' : ''} disabled={!exists || locked} onClick={(event) => { event.stopPropagation(); onToggleMute() }}>M</button>
      <button title="独奏 (S)" aria-label={`${name || STEM_META[type].label}独奏`} className={state.solo ? 'active' : ''} disabled={!exists || locked} onClick={(event) => { event.stopPropagation(); onPatch({ solo: !state.solo }) }}>S</button>
    </span><TrackMeter id={type} /></div>
    <TrackGainControl label={`${STEM_META[type].label}电平`} value={state.gainDb} disabled={!exists || locked} onChange={(gainDb) => onPatch({ gainDb })} />
    <span className="track-output-route" onClick={(event) => event.stopPropagation()}>
      <small>OUT</small>
      <SelectMenu
        ariaLabel={`${STEM_META[type].label}输出通道`}
        value={selectedPair}
        disabled={!exists || locked}
        options={[
          ...(selectedPairAvailable ? [] : [{ value: selectedPair, label: `${selectedPair}–${selectedPair + 1}（不可用）`, disabled: true }]),
          ...outputPairs.map((firstChannel) => ({ value: firstChannel, label: `${firstChannel}–${firstChannel + 1}` }))
        ]}
        onChange={(pair) => onPatch({ outputChannelPair: pair })}
      />
    </span>
    {showWaveform && <div className="meter-wave"><Waveform stemType={type} peaksUrl={peaksUrl} color={STEM_META[type].color} durationMs={durationMs} currentMs={currentMs} loopStartMs={practice.loopStartMs} loopEndMs={practice.loopEndMs} zoom={practice.zoom} scroll={practice.scroll} disabled={!exists || locked} onSeek={onSeek} onRange={onRange} onViewChange={onViewChange} /></div>}
  </SortableTrackRow>
}

interface RecordingTrackRowProps extends TrackDragProps {
  onDeleteTrack?(): void
  onEffectsChanged?(): void
  song: SongDetail
  recordingTrack: RecordingTrackState
  takes: RecordingTake[]
  practice: PracticeState
  currentMs?: number
  state: RecordingState
  meter?: RecordingMeter
  soloActive: boolean
  locked: boolean
  onRecord(): void
  onStop(): void
  onCancel(): void
  onSelectTake(takeId: string | null): void
  onUpdateTake(takeId: string, patch: { name?: string; alignmentOffsetMs?: number }): void
  onDeleteTake(takeId: string): void
  onTrack(patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>): void
  onToggleMute(): void
  onUseTakePractice(rate: number, pitchSemitones: number): void
  onSeek(milliseconds: number): void
  onRange(start: number, end: number): void
  onViewChange(zoom: number, scroll: number): void
}

function RecordingTrackRow(props: RecordingTrackRowProps): React.JSX.Element {
  const {
    song, recordingTrack: track, takes, practice, currentMs, state, meter: suppliedMeter, soloActive, locked, onRecord, onStop, onCancel, onSelectTake,
    onUpdateTake, onDeleteTake, onDeleteTrack, onEffectsChanged, onTrack, onToggleMute, onUseTakePractice, onSeek, onRange, onViewChange, ...dragProps
  } = props
  const liveMeter = useRecordingMeterStore((store) => state.recordingTrackId === track.id ? store.meter : null)
  const meter = suppliedMeter ?? liveMeter ?? useRecordingMeterStore.getState().meter
  const activeTake = takes.find((take) => take.id === track.activeTakeId) ?? null
  const running = !['idle', 'failed'].includes(state.phase)
  const activeRunning = running && state.recordingTrackId === track.id

  return <SortableTrackRow
    {...dragProps}
    label={track.name}
    className={`track-row recording-track ${activeRunning ? 'is-recording' : ''}`}
    locked={locked}
  >
    <span className="track-identity recording-identity" style={{ '--track': '#b84f45' } as React.CSSProperties}>
      <i><Mic2 size={21} /></i><TrackName name={track.name} disabled={locked} onChange={name => onTrack({ name })} />
    </span>
    <RecordingEffects track={track} busy={locked && (!activeRunning || !['armed', 'countIn', 'recording'].includes(state.phase))} recording={activeRunning} inputPeak={activeRunning ? Math.max(...meter.peak, 0) : undefined} onChanged={running ? undefined : onEffectsChanged} onDelete={onDeleteTrack} deleteDisabled={running || locked} controls={<>
      <button title="静音 (M)" aria-label={`${track.name}静音`} className={isSilenced(track) ? 'active' : isImpliedMuted(track, soloActive && Boolean(activeTake)) ? 'is-implied-muted' : ''} disabled={locked || !activeTake} onClick={onToggleMute}>M</button>
      <button title="独奏 (S)" aria-label={`${track.name}独奏`} className={track.solo ? 'active' : ''} disabled={locked || !activeTake} onClick={() => onTrack({ solo: !track.solo, ...(!track.solo ? { muted: false } : {}) })}>S</button>
    </>} />
    <TrackGainControl label={`${track.name || '录音轨'}电平`} value={track.gainDb} disabled={locked || !activeTake} onChange={(gainDb) => onTrack({ gainDb })} />
    <span className="recording-actions">
      {!running
        ? <button className="record-button" aria-label={`在${track.name}开始录音`} onClick={onRecord}><Circle size={16} fill="currentColor" /></button>
        : activeRunning
          ? <><button className="stop-record-button" aria-label="停止并保存录音" onClick={onStop}><Square size={15} fill="currentColor" /></button><button aria-label="放弃录音" onClick={onCancel}>×</button></>
          : <button className="record-button" aria-label="其他录音轨正在录音" disabled><Circle size={16} /></button>}
    </span>
    <div className="recording-wave-wrap">
      {<div className="meter-wave"><Waveform
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
      /></div>}
    </div>
  </SortableTrackRow>
}

function TrackName({ name, disabled, onChange }: { name: string; disabled: boolean; onChange(name: string): void }): React.JSX.Element {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name)
  const cancel = useRef(false)
  const commit = (): void => {
    setEditing(false)
    if (!cancel.current && draft.trim() && draft.trim() !== name) onChange(draft.trim())
  }
  return editing ? <input className="track-name-input" aria-label={`重命名${name}`} value={draft} maxLength={100} autoFocus
    onFocus={event => event.currentTarget.select()} onClick={event => event.stopPropagation()}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancel.current = true; event.currentTarget.blur() } }} />
    : <b title={`${name}（双击修改名称）`} tabIndex={disabled ? undefined : 0} onDoubleClick={event => { event.stopPropagation(); if (!disabled) { cancel.current = false; setDraft(name); setEditing(true) } }} onKeyDown={event => { if (!disabled && event.key === 'Enter') { event.stopPropagation(); cancel.current = false; setDraft(name); setEditing(true) } }}>{name}</b>
}

function SharedPlayhead({ durationMs, currentMs, zoom, scroll }: { durationMs: number; currentMs?: number; zoom: number; scroll: number }): React.JSX.Element {
  const cursor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const paint = (ms: number): void => {
      if (!cursor.current) return
      const span = 1 / Math.max(1, zoom), start = clamp(scroll, 0, 1) * (1 - span)
      const fraction = durationMs ? (ms / durationMs - start) / span : 0
      cursor.current.style.left = `${fraction * 100}%`
      cursor.current.style.visibility = fraction >= 0 && fraction <= 1 ? 'visible' : 'hidden'
    }
    paint(currentMs ?? usePlayerStore.getState().currentMs)
    if (currentMs !== undefined) return
    return usePlayerStore.subscribe((state, previous) => { if (state.currentMs !== previous.currentMs) paint(state.currentMs) })
  }, [currentMs, durationMs, zoom, scroll])
  return <div className="shared-wave-timeline" aria-hidden="true"><div ref={cursor} className="shared-wave-playhead" /></div>
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
