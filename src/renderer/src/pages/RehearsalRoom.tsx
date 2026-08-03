import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Copy,
  FastForward,
  GripVertical,
  ListMusic,
  Mic2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AppSettings,
  type DesktopLyricsPayload,
  type RecordingMeter,
  type SongDetail,
  type SongSummary
} from '@shared/domain.js'
import { lyricFrameAt } from '@shared/lyrics.js'
import {
  buildRehearsalTimeline,
  clampTransitionDuration,
  rehearsalTimelinePosition,
  REHEARSAL_TRANSITION_DEFAULT_MS,
  type RehearsalItem,
  type RehearsalRecordingState,
  type RehearsalRecordingTake,
  type RehearsalRecordingTrackState,
  type RehearsalSetDetail,
  type RehearsalSetSummary,
  type RehearsalTimeline,
  type RehearsalTimelinePosition
} from '@shared/rehearsal.js'
import { RehearsalAudioEngine } from '../rehearsal-audio-engine.js'
import { fixtureDetail, fixtureSongs } from '../fixtures.js'
import { clamp, formatTime, gainLabel, isCancellationError, toUserErrorMessage } from '../utils.js'

const fixtureMode = import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')

const idleRecordingState: RehearsalRecordingState = {
  target: 'rehearsal',
  phase: 'idle',
  sessionId: null,
  rehearsalId: null,
  recordingTrackId: null,
  revisionId: null,
  timelineFingerprint: null,
  timelinePositionMs: 0,
  preRollRemaining: 0,
  sampleRate: 0,
  bufferFrames: 0,
  latencyMs: 0,
  xruns: 0,
  splitDevices: false,
  message: '',
  error: null
}

const idleMeter: RecordingMeter = {
  peak: [0, 0],
  rms: [0, 0],
  clipped: false,
  sourcePositionMs: 0,
  recording: false
}

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'failed'
type DragSource =
  | { kind: 'existing'; itemId: string }
  | { kind: 'song'; songId: string }
  | { kind: 'transition' }
type DropTarget = { itemId: string | null; placement: 'before' | 'after' }

interface RehearsalRoomProps {
  settings?: AppSettings
  initialRehearsalId?: string | null
  initialItemId?: string | null
  initialScrollTop?: number
  onActiveChange(rehearsalId: string | null): void
  onOpenSongSettings(input: {
    rehearsalId: string
    itemId: string
    songId: string
    scrollTop: number
  }): void
  onRecordingLockChange(locked: boolean): void
  onToast(message: string): void
}

export function RehearsalRoom({
  settings,
  initialRehearsalId,
  initialItemId,
  initialScrollTop = 0,
  onActiveChange,
  onOpenSongSettings,
  onRecordingLockChange,
  onToast
}: RehearsalRoomProps): React.JSX.Element {
  const engine = useRef(new RehearsalAudioEngine())
  const page = useRef<HTMLElement>(null)
  const rehearsalRef = useRef<RehearsalSetDetail | null>(null)
  const songsRef = useRef(new Map<string, SongDetail>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveVersion = useRef(0)
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const dirty = useRef(false)
  const booted = useRef(false)
  const recordingWasActive = useRef(false)
  const dragSourceRef = useRef<DragSource | null>(null)
  const dropTargetRef = useRef<DropTarget | null>(null)
  const dragCleanup = useRef<() => void>(() => undefined)
  const lastLyricsUpdate = useRef({ at: 0, signature: '' })

  const [sets, setSets] = useState<RehearsalSetSummary[]>([])
  const [rehearsal, setRehearsal] = useState<RehearsalSetDetail | null>(null)
  const [librarySongs, setLibrarySongs] = useState<SongSummary[]>([])
  const [songDetails, setSongDetails] = useState<Map<string, SongDetail>>(new Map())
  const [libraryQuery, setLibraryQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [playing, setPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [position, setPosition] = useState<RehearsalTimelinePosition>({
    segment: null,
    globalMs: 0,
    segmentMs: 0,
    songSourceMs: 0
  })
  const [recordingState, setRecordingState] = useState<RehearsalRecordingState>(idleRecordingState)
  const [recordingMeter, setRecordingMeter] = useState<RecordingMeter>(idleMeter)
  const [dragSource, setDragSource] = useState<DragSource | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const timeline = useMemo(
    () => buildRehearsalTimeline(rehearsal?.items ?? [], [...songDetails.values()]),
    [rehearsal?.items, songDetails]
  )
  const recordingActive = !['idle', 'failed'].includes(recordingState.phase)
  const structureLocked = recordingActive || playing
  const filteredSongs = useMemo(() => {
    const normalized = libraryQuery.trim().toLocaleLowerCase()
    return librarySongs
      .filter((song) => song.status === 'ready')
      .filter((song) => !normalized || `${song.title} ${song.artist}`.toLocaleLowerCase().includes(normalized))
  }, [libraryQuery, librarySongs])

  const setCurrentRehearsal = useCallback((next: RehearsalSetDetail): void => {
    rehearsalRef.current = next
    setRehearsal(next)
    setCurrentMs(0)
    setPosition(rehearsalTimelinePosition(buildRehearsalTimeline(next.items, [...songsRef.current.values()]), 0))
    setSaveStatus('saved')
    dirty.current = false
    saveVersion.current += 1
    onActiveChange(next.id)
  }, [onActiveChange])

  const resolveSongDetails = useCallback(async (items: readonly RehearsalItem[]): Promise<Map<string, SongDetail>> => {
    const ids = [...new Set(items.flatMap((item) => item.kind === 'song' && item.songId ? [item.songId] : []))]
    const details = await Promise.all(ids.map(async (songId) => {
      if (fixtureMode) {
        const summary = fixtureSongs.find((candidate) => candidate.id === songId)
        return summary ? fixtureDetail(summary) : null
      }
      return window.bandbuddy.library.get(songId)
    }))
    const next = new Map(details.flatMap((detail) => detail ? [[detail.id, detail] as const] : []))
    songsRef.current = next
    setSongDetails(next)
    return next
  }, [])

  const refreshSetList = useCallback(async (): Promise<RehearsalSetSummary[]> => {
    const next = await window.bandbuddy.rehearsals.list()
    setSets(next)
    return next
  }, [])

  const loadRehearsal = useCallback(async (rehearsalId: string): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.bandbuddy.rehearsals.get(rehearsalId)
      if (!next) throw new Error('REHEARSAL_NOT_FOUND')
      await resolveSongDetails(next.items)
      setCurrentRehearsal(next)
    } catch (error) {
      onToast(toUserErrorMessage(error, '无法打开排练编排单'))
    } finally {
      setLoading(false)
    }
  }, [onToast, resolveSongDetails, setCurrentRehearsal])

  const updateSetListEntry = useCallback((next: RehearsalSetDetail): void => {
    const summary: RehearsalSetSummary = {
      id: next.id,
      name: next.name,
      itemCount: next.items.length,
      songCount: next.items.filter((item) => item.kind === 'song').length,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      lastOpenedAt: next.lastOpenedAt
    }
    setSets((current) => {
      const found = current.some((item) => item.id === next.id)
      return found
        ? current.map((item) => item.id === next.id ? summary : item)
        : [summary, ...current]
    })
  }, [])

  const persist = useCallback(async (version: number): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const draft = rehearsalRef.current
    if (!draft || !dirty.current && version === saveVersion.current) return
    setSaveStatus('saving')
    const operation = saveQueue.current.then(() => window.bandbuddy.rehearsals.save({
      id: draft.id,
      name: draft.name.trim() || '未命名编排单',
      items: draft.items
    }))
    saveQueue.current = operation.catch(() => undefined)
    try {
      const saved = await operation
      if (version === saveVersion.current && rehearsalRef.current?.id === saved.id) {
        rehearsalRef.current = saved
        setRehearsal(saved)
        setSaveStatus('saved')
        dirty.current = false
        updateSetListEntry(saved)
      }
    } catch (error) {
      setSaveStatus('failed')
      onToast(toUserErrorMessage(error, '自动保存失败，请重试'))
    }
  }, [onToast, updateSetListEntry])

  const flushSave = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (!dirty.current || !rehearsalRef.current) {
      await saveQueue.current
      return
    }
    await persist(saveVersion.current)
  }, [persist])

  const commitDraft = useCallback((next: RehearsalSetDetail): void => {
    rehearsalRef.current = next
    setRehearsal(next)
    const version = ++saveVersion.current
    dirty.current = true
    setSaveStatus('dirty')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void persist(version), 500)
  }, [persist])

  const refreshCurrentRehearsal = useCallback(async (): Promise<RehearsalSetDetail | null> => {
    const current = rehearsalRef.current
    if (!current) return null
    const next = await window.bandbuddy.rehearsals.get(current.id)
    if (!next) return null
    rehearsalRef.current = next
    setRehearsal(next)
    updateSetListEntry(next)
    return next
  }, [updateSetListEntry])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      try {
        const [availableSets, availableSongs] = await Promise.all([
          window.bandbuddy.rehearsals.list(),
          fixtureMode ? Promise.resolve(fixtureSongs) : window.bandbuddy.library.list({ filter: 'all' })
        ])
        setLibrarySongs(availableSongs)
        let nextSets = availableSets
        let targetId = initialRehearsalId && availableSets.some((item) => item.id === initialRehearsalId)
          ? initialRehearsalId
          : availableSets[0]?.id
        if (!targetId) {
          const created = await window.bandbuddy.rehearsals.create('新排练编排')
          targetId = created.id
          nextSets = [{
            id: created.id,
            name: created.name,
            itemCount: 0,
            songCount: 0,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            lastOpenedAt: created.lastOpenedAt
          }]
        }
        setSets(nextSets)
        await loadRehearsal(targetId)
        requestAnimationFrame(() => {
          if (page.current) page.current.scrollTop = initialScrollTop
          if (initialItemId) document.querySelector<HTMLElement>(`[data-rehearsal-item-id="${initialItemId}"]`)?.focus()
        })
      } catch (error) {
        setLoading(false)
        onToast(toUserErrorMessage(error, '无法打开排练房'))
      }
    })()
  }, [initialItemId, initialRehearsalId, initialScrollTop, loadRehearsal, onToast])

  useEffect(() => {
    if (loading || !rehearsal || !initialItemId) return
    const frame = requestAnimationFrame(() => {
      if (page.current) page.current.scrollTop = initialScrollTop
      document.querySelector<HTMLElement>(
        `[data-rehearsal-item-id="${initialItemId}"]`
      )?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [initialItemId, initialScrollTop, loading, rehearsal])

  useEffect(() => {
    const stopHidden = window.bandbuddy.window.onHidden(() => void flushSave())
    const stopSets = window.bandbuddy.rehearsals.onChanged(() => void refreshSetList())
    const stopLibrary = window.bandbuddy.library.onChanged(() => {
      void (async () => {
        const next = fixtureMode ? fixtureSongs : await window.bandbuddy.library.list({ filter: 'all' })
        setLibrarySongs(next)
        if (!playing && !recordingActive && rehearsalRef.current) await resolveSongDetails(rehearsalRef.current.items)
      })()
    })
    return () => {
      stopHidden()
      stopSets()
      stopLibrary()
      void flushSave()
    }
  }, [flushSave, playing, recordingActive, refreshSetList, resolveSongDetails])

  useEffect(() => {
    engine.current.onTime((next, isPlaying) => {
      setCurrentMs(next.globalMs)
      setPosition(next)
      setPlaying(isPlaying)
    })
    engine.current.onEnded(() => setPlaying(false))
    return () => engine.current.destroy()
  }, [])

  const configurePlayback = useCallback(async (
    nextTimeline: RehearsalTimeline,
    details: Map<string, SongDetail>,
    source = rehearsalRef.current
  ): Promise<void> => {
    if (!source) return
    await engine.current.configure({
      timeline: nextTimeline,
      songs: [...details.values()],
      recordingTracks: source.recordingTracks,
      recordingTakes: source.recordingTakes,
      outputDeviceId: settings?.audioOutputDeviceId ?? '',
      latencyMode: settings?.latencyMode ?? 'interactive'
    })
  }, [settings?.audioOutputDeviceId, settings?.latencyMode])

  useEffect(() => {
    if (!rehearsal || playing || recordingActive) return
    void configurePlayback(timeline, songDetails).catch(() => {
      onToast('无法准备排练音频，请检查歌曲文件和输出设备')
    })
  }, [configurePlayback, onToast, playing, recordingActive, rehearsal, songDetails, timeline])

  useEffect(() => {
    void window.bandbuddy.rehearsals.recordingState().then(setRecordingState)
    const stopState = window.bandbuddy.rehearsals.onRecordingState((next) => {
      setRecordingState(next)
      if (!['idle', 'failed'].includes(next.phase)) {
        recordingWasActive.current = true
        setCurrentMs(next.timelinePositionMs)
        const currentTimeline = buildRehearsalTimeline(
          rehearsalRef.current?.items ?? [],
          [...songsRef.current.values()]
        )
        setPosition(rehearsalTimelinePosition(currentTimeline, next.timelinePositionMs))
      } else if (next.phase === 'idle' && recordingWasActive.current) {
        recordingWasActive.current = false
        void refreshCurrentRehearsal()
      }
      if (next.error && !isCancellationError(next.error)) {
        onToast(toUserErrorMessage(next.error, '排练录音失败，请检查声卡后重试'))
      }
    })
    const stopMeter = window.bandbuddy.rehearsals.onMeter(setRecordingMeter)
    return () => {
      stopState()
      stopMeter()
    }
  }, [onToast, refreshCurrentRehearsal])

  useEffect(() => {
    onRecordingLockChange(recordingActive)
    return () => onRecordingLockChange(false)
  }, [onRecordingLockChange, recordingActive])

  useEffect(() => {
    if (!rehearsal) return
    setPosition(rehearsalTimelinePosition(timeline, currentMs))
  }, [currentMs, rehearsal, timeline])

  const activeLyricSong = position.segment?.songId
    ? songDetails.get(position.segment.songId) ?? null
    : null
  const desktopLyricsVisible = Boolean(
    position.segment
    && position.segment.kind !== 'transition'
    && position.segment.desktopLyricsEnabled
    && activeLyricSong?.lyrics?.cues.length
  )

  useEffect(() => {
    void window.bandbuddy.desktopLyrics.setVisible(desktopLyricsVisible).catch(() => {
      if (desktopLyricsVisible) onToast('无法打开桌面歌词，请重启应用后重试')
    })
  }, [desktopLyricsVisible, onToast])

  useEffect(() => {
    if (!desktopLyricsVisible || !activeLyricSong?.lyrics) return
    const sourceMs = position.segment?.kind === 'song' ? position.songSourceMs : 0
    const frame = lyricFrameAt(activeLyricSong.lyrics.cues, sourceMs)
    const currentLines = (frame.current?.lines ?? [
      activeLyricSong.artist ? `${activeLyricSong.title} · ${activeLyricSong.artist}` : activeLyricSong.title
    ]).slice(0, 4).map((line) => line.slice(0, 1000))
    const nextLines = (frame.next?.lines ?? []).slice(0, 4).map((line) => line.slice(0, 1000))
    const running = playing || recordingActive
    const signature = `${activeLyricSong.id}\n${running}\n${currentLines.join('\n')}\n${nextLines.join('\n')}`
    const now = performance.now()
    if (signature === lastLyricsUpdate.current.signature && now - lastLyricsUpdate.current.at < 80) return
    lastLyricsUpdate.current = { at: now, signature }
    const payload: DesktopLyricsPayload = {
      title: activeLyricSong.title,
      artist: activeLyricSong.artist,
      currentLines,
      nextLines,
      progress: frame.progress,
      playing: running
    }
    window.bandbuddy.desktopLyrics.update(payload)
  }, [activeLyricSong, desktopLyricsVisible, playing, position.segment?.kind, position.songSourceMs, recordingActive])

  useEffect(() => () => {
    void window.bandbuddy.desktopLyrics.setVisible(false)
  }, [])

  const switchRehearsal = async (rehearsalId: string): Promise<void> => {
    if (recordingActive || rehearsalId === rehearsalRef.current?.id) return
    engine.current.pause()
    setPlaying(false)
    await flushSave()
    await loadRehearsal(rehearsalId)
  }

  const createRehearsal = async (): Promise<void> => {
    if (recordingActive) return
    engine.current.pause()
    setPlaying(false)
    await flushSave()
    const created = await window.bandbuddy.rehearsals.create('新排练编排')
    updateSetListEntry(created)
    await resolveSongDetails(created.items)
    setCurrentRehearsal(created)
  }

  const duplicateRehearsal = async (revisionId?: string): Promise<void> => {
    const current = rehearsalRef.current
    if (!current || recordingActive) return
    engine.current.pause()
    setPlaying(false)
    await flushSave()
    try {
      const duplicate = await window.bandbuddy.rehearsals.duplicate({
        rehearsalId: current.id,
        ...(revisionId ? { revisionId } : {})
      })
      updateSetListEntry(duplicate)
      await resolveSongDetails(duplicate.items)
      setCurrentRehearsal(duplicate)
      onToast(revisionId ? '已从录音版本创建新编排单' : '已复制编排单（录音未复制）')
    } catch (error) {
      onToast(toUserErrorMessage(error, '复制编排单失败'))
    }
  }

  const deleteRehearsal = async (): Promise<void> => {
    const current = rehearsalRef.current
    if (!current || recordingActive || !window.confirm(`确定删除“${current.name}”？相关排练录音会移入系统废纸篓。`)) return
    engine.current.pause()
    setPlaying(false)
    await flushSave()
    try {
      await window.bandbuddy.rehearsals.delete(current.id)
      let remaining = await refreshSetList()
      let nextId = remaining[0]?.id
      if (!nextId) {
        const created = await window.bandbuddy.rehearsals.create('新排练编排')
        updateSetListEntry(created)
        remaining = await refreshSetList()
        nextId = created.id
      }
      if (nextId) await loadRehearsal(nextId)
    } catch (error) {
      onToast(toUserErrorMessage(error, '删除编排单失败'))
    }
  }

  const makeItem = (source: DragSource): RehearsalItem | null => {
    if (source.kind === 'existing') {
      return rehearsalRef.current?.items.find((item) => item.id === source.itemId) ?? null
    }
    if (source.kind === 'transition') {
      return { id: crypto.randomUUID(), kind: 'transition', durationMs: REHEARSAL_TRANSITION_DEFAULT_MS }
    }
    const summary = librarySongs.find((song) => song.id === source.songId)
    if (!summary || summary.status !== 'ready') return null
    return {
      id: crypto.randomUUID(),
      kind: 'song',
      songId: summary.id,
      title: summary.title,
      artist: summary.artist,
      durationMs: summary.durationMs,
      artworkUrl: summary.artworkUrl,
      available: true
    }
  }

  const applyDrop = (source: DragSource, target: DropTarget): void => {
    const current = rehearsalRef.current
    if (!current || structureLocked) return
    const item = makeItem(source)
    if (!item) return
    const remaining = source.kind === 'existing'
      ? current.items.filter((candidate) => candidate.id !== source.itemId)
      : [...current.items]
    let index = remaining.length
    if (target.itemId) {
      const targetIndex = remaining.findIndex((candidate) => candidate.id === target.itemId)
      if (targetIndex >= 0) index = targetIndex + (target.placement === 'after' ? 1 : 0)
    }
    const items = [...remaining.slice(0, index), item, ...remaining.slice(index)]
    commitDraft({
      ...current,
      items,
      itemCount: items.length,
      songCount: items.filter((candidate) => candidate.kind === 'song').length
    })
    if (source.kind === 'song' && !songsRef.current.has(source.songId)) {
      void resolveSongDetails(items)
    }
  }

  const addAtEnd = (source: DragSource): void => applyDrop(source, { itemId: null, placement: 'after' })

  const moveWithKeyboard = (itemId: string, direction: -1 | 1): void => {
    const current = rehearsalRef.current
    if (!current || structureLocked) return
    const index = current.items.findIndex((item) => item.id === itemId)
    const target = current.items[index + direction]
    if (index < 0 || !target) return
    applyDrop(
      { kind: 'existing', itemId },
      { itemId: target.id, placement: direction < 0 ? 'before' : 'after' }
    )
  }

  const removeItem = (itemId: string): void => {
    const current = rehearsalRef.current
    if (!current || structureLocked) return
    const items = current.items.filter((item) => item.id !== itemId)
    commitDraft({
      ...current,
      items,
      itemCount: items.length,
      songCount: items.filter((item) => item.kind === 'song').length
    })
  }

  const updateTransition = (itemId: string, seconds: number): void => {
    const current = rehearsalRef.current
    if (!current || structureLocked) return
    const durationMs = clampTransitionDuration(seconds * 1000)
    const items = current.items.map((item) => item.id === itemId && item.kind === 'transition'
      ? { ...item, durationMs }
      : item)
    commitDraft({ ...current, items })
  }

  const clearDrag = (): void => {
    dragCleanup.current()
    dragCleanup.current = () => undefined
    dragSourceRef.current = null
    dropTargetRef.current = null
    setDragSource(null)
    setDropTarget(null)
  }

  const finishPointerDrag = (): void => {
    const source = dragSourceRef.current
    const target = dropTargetRef.current
    if (source && target) applyDrop(source, target)
    clearDrag()
  }

  const startPointerDrag = (source: DragSource): void => {
    if (structureLocked) return
    clearDrag()
    dragSourceRef.current = source
    setDragSource(source)
    const move = (event: PointerEvent): void => {
      const element = document.elementFromPoint(event.clientX, event.clientY)
      const row = element?.closest<HTMLElement>('.rehearsal-queue-item')
      const queue = element?.closest<HTMLElement>('.rehearsal-queue')
      let target: DropTarget | null = null
      if (row?.dataset.rehearsalItemId) {
        const bounds = row.getBoundingClientRect()
        target = {
          itemId: row.dataset.rehearsalItemId,
          placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
        }
      } else if (queue) {
        target = { itemId: null, placement: 'after' }
      }
      dropTargetRef.current = target
      setDropTarget(target)
    }
    const up = (): void => finishPointerDrag()
    const cancel = (): void => clearDrag()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    dragCleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }

  useEffect(() => () => clearDrag(), [])

  const readNativeDrag = (event: React.DragEvent): DragSource | null => {
    try {
      return JSON.parse(event.dataTransfer.getData('application/x-bandbuddy-rehearsal')) as DragSource
    } catch {
      return null
    }
  }

  const writeNativeDrag = (event: React.DragEvent, source: DragSource): void => {
    event.dataTransfer.effectAllowed = source.kind === 'existing' ? 'move' : 'copy'
    event.dataTransfer.setData('application/x-bandbuddy-rehearsal', JSON.stringify(source))
    dragSourceRef.current = source
    setDragSource(source)
  }

  const refreshBeforePlayback = async (): Promise<{
    details: Map<string, SongDetail>
    timeline: RehearsalTimeline
  } | null> => {
    const current = rehearsalRef.current
    if (!current) return null
    const details = await resolveSongDetails(current.items)
    const nextTimeline = buildRehearsalTimeline(current.items, [...details.values()])
    if (!nextTimeline.segments.length) {
      onToast('编排单为空，请先加入歌曲或衔接')
      return null
    }
    if (nextTimeline.unavailableItemIds.length) {
      onToast('编排中有不可用歌曲，请先移除或替换')
      return null
    }
    await configurePlayback(nextTimeline, details, current)
    return { details, timeline: nextTimeline }
  }

  const togglePlayback = async (): Promise<void> => {
    if (recordingActive) return
    if (playing) {
      engine.current.pause()
      setPlaying(false)
      return
    }
    try {
      const plan = await refreshBeforePlayback()
      if (!plan) return
      await engine.current.play()
    } catch (error) {
      onToast(toUserErrorMessage(error, '排练播放失败，请检查歌曲文件或输出设备'))
    }
  }

  const seek = async (milliseconds: number): Promise<void> => {
    if (recordingActive) return
    await engine.current.seek(clamp(milliseconds, 0, timeline.totalDurationMs))
  }

  const stopPlayback = async (): Promise<void> => {
    if (recordingActive) return
    await engine.current.stop()
    setPlaying(false)
  }

  const openSongSettings = async (itemId: string, songId: string): Promise<void> => {
    if (recordingActive) return
    engine.current.pause()
    setPlaying(false)
    await flushSave()
    const current = rehearsalRef.current
    if (!current) return
    onOpenSongSettings({
      rehearsalId: current.id,
      itemId,
      songId,
      scrollTop: page.current?.scrollTop ?? 0
    })
  }

  const startRecording = async (recordingTrackId: string): Promise<void> => {
    const current = rehearsalRef.current
    if (!current || recordingActive) return
    engine.current.pause()
    setPlaying(false)
    setRecordingMeter({ ...idleMeter, sourcePositionMs: currentMs })
    try {
      await flushSave()
      const plan = await refreshBeforePlayback()
      if (!plan) return
      await window.bandbuddy.rehearsals.startRecording({
        rehearsalId: current.id,
        recordingTrackId,
        positionMs: currentMs
      })
    } catch (error) {
      if (!isCancellationError(error)) {
        onToast(toUserErrorMessage(error, '排练录音失败，请检查声卡后重试'))
      }
    }
  }

  const stopRecording = async (): Promise<void> => {
    try {
      await window.bandbuddy.rehearsals.stopRecording()
      await refreshCurrentRehearsal()
    } catch (error) {
      onToast(toUserErrorMessage(error, '停止排练录音失败，请重试'))
    }
  }

  const cancelRecording = async (): Promise<void> => {
    if (!window.confirm('放弃本次排练录音？未保存的音频会被删除。')) return
    await window.bandbuddy.rehearsals.cancelRecording()
    setRecordingMeter(idleMeter)
  }

  const createRecordingTrack = async (): Promise<void> => {
    const current = rehearsalRef.current
    if (!current || recordingActive) return
    try {
      await flushSave()
      await window.bandbuddy.rehearsals.createTrack(current.id)
      await refreshCurrentRehearsal()
    } catch (error) {
      onToast(toUserErrorMessage(error, '无法创建排练录音轨'))
    }
  }

  const updateRecordingTrack = async (
    recordingTrackId: string,
    patch: Partial<Pick<RehearsalRecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): Promise<void> => {
    if (recordingActive) return
    try {
      await window.bandbuddy.rehearsals.updateTrack({ recordingTrackId, patch })
      await refreshCurrentRehearsal()
    } catch (error) {
      onToast(toUserErrorMessage(error, '无法更新排练录音轨'))
    }
  }

  const selectTake = async (recordingTrackId: string, takeId: string | null): Promise<void> => {
    if (recordingActive) return
    await window.bandbuddy.rehearsals.selectTake({ recordingTrackId, takeId })
    await refreshCurrentRehearsal()
  }

  const updateTake = async (
    takeId: string,
    patch: { name?: string; alignmentOffsetMs?: number }
  ): Promise<void> => {
    if (recordingActive) return
    await window.bandbuddy.rehearsals.updateTake({ takeId, ...patch })
    await refreshCurrentRehearsal()
  }

  const deleteTake = async (take: RehearsalRecordingTake): Promise<void> => {
    if (recordingActive || !window.confirm(`确定删除“${take.name}”？此操作无法撤销。`)) return
    await window.bandbuddy.rehearsals.deleteTake(take.id)
    await refreshCurrentRehearsal()
  }

  if (loading || !rehearsal) {
    return <main className="page rehearsal-page rehearsal-loading">
      <div className="rehearsal-loading-record"><ListMusic size={32} /></div>
      <h2>正在准备排练房…</h2>
    </main>
  }

  const activeItemId = position.segment?.itemId ?? null
  const activeLabel = position.segment
    ? position.segment.kind === 'transition'
      ? '空白衔接'
      : `${position.segment.title}${position.segment.kind === 'countIn' ? ' · 预备拍' : ''}`
    : rehearsal.items.length ? '准备开始' : '编排单为空'

  return <>
    <main ref={page} className={`page rehearsal-page ${recordingActive ? 'is-recording' : ''}`}>
      <header className="rehearsal-header">
        <div className="rehearsal-set-picker">
          <ListMusic size={19} />
          <select
            aria-label="选择排练编排单"
            value={rehearsal.id}
            disabled={recordingActive}
            onChange={(event) => void switchRehearsal(event.target.value)}
          >
            {sets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <ChevronDown size={14} />
        </div>
        <input
          className="rehearsal-name"
          aria-label="编排单名称"
          value={rehearsal.name}
          disabled={recordingActive}
          maxLength={120}
          onChange={(event) => commitDraft({ ...rehearsal, name: event.target.value })}
          onBlur={() => {
            if (!rehearsal.name.trim()) commitDraft({ ...rehearsal, name: '未命名编排单' })
          }}
        />
        <div className={`autosave-state ${saveStatus}`}>
          {saveStatus === 'saved' ? <Check size={14} /> : saveStatus === 'failed' ? <AlertTriangle size={14} /> : <Save size={14} />}
          {saveStatus === 'saved' ? '已自动保存' : saveStatus === 'saving' ? '正在保存' : saveStatus === 'dirty' ? '等待保存' : '保存失败'}
        </div>
        <div className="rehearsal-header-actions">
          <button className="outline-button compact" disabled={recordingActive} onClick={() => void createRehearsal()}><Plus size={15} />新建</button>
          <button className="outline-button compact" disabled={recordingActive} onClick={() => void duplicateRehearsal()}><Copy size={15} />复制</button>
          <button className="outline-button compact danger" disabled={recordingActive} onClick={() => void deleteRehearsal()}><Trash2 size={15} />删除</button>
        </div>
        <div className="rehearsal-stats">
          <b>{rehearsal.songCount}</b><span>首歌曲</span><i />
          <b>{formatTime(timeline.totalDurationMs)}</b><span>总时长</span>
        </div>
      </header>

      {timeline.unavailableItemIds.length > 0 && <div className="rehearsal-warning">
        <AlertTriangle size={17} />
        <span><b>编排中有 {timeline.unavailableItemIds.length} 首不可用歌曲</b>歌曲已从曲库删除或尚未就绪。占位项会保留，但播放和录音前必须移除或替换。</span>
      </div>}

      <section className="rehearsal-layout">
        <aside className="rehearsal-palette">
          <div className="rehearsal-section-title">
            <span><ListMusic size={17} /><b>曲库素材</b></span>
            <small>{filteredSongs.length} 首可用</small>
          </div>
          <label className="rehearsal-search">
            <Search size={16} />
            <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索歌曲或艺术家" />
            {libraryQuery && <button aria-label="清空搜索" onClick={() => setLibraryQuery('')}><X size={14} /></button>}
          </label>
          <button
            className="transition-asset"
            disabled={structureLocked}
            draggable={!structureLocked}
            onDragStart={(event) => writeNativeDrag(event, { kind: 'transition' })}
            onDragEnd={clearDrag}
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse') startPointerDrag({ kind: 'transition' })
            }}
            onDoubleClick={() => addAtEnd({ kind: 'transition' })}
          >
            <span><Timer size={19} /></span>
            <b>空白衔接</b>
            <small>默认 10 秒 · 拖入队列</small>
            <Plus size={15} />
          </button>
          <div className="rehearsal-song-assets">
            {filteredSongs.map((song) => <article
              key={song.id}
              className="rehearsal-song-asset"
              draggable={!structureLocked}
              onDragStart={(event) => writeNativeDrag(event, { kind: 'song', songId: song.id })}
              onDragEnd={clearDrag}
              onPointerDown={(event) => {
                if (event.pointerType !== 'mouse') startPointerDrag({ kind: 'song', songId: song.id })
              }}
            >
              <Artwork artworkUrl={song.artworkUrl} title={song.title} />
              <span><b>{song.title}</b><small>{song.artist || '未知艺术家'} · {formatTime(song.durationMs)}</small></span>
              <button
                aria-label={`将 ${song.title} 加入队列`}
                disabled={structureLocked}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => addAtEnd({ kind: 'song', songId: song.id })}
              ><Plus size={15} /></button>
            </article>)}
            {filteredSongs.length === 0 && <div className="rehearsal-no-assets">没有匹配的已就绪歌曲</div>}
          </div>
          <p className="drag-help"><GripVertical size={13} />拖动素材到右侧；双击空白衔接可直接追加</p>
        </aside>

        <div className="rehearsal-editor">
          <section className="rehearsal-overview">
            <header>
              <span><b>整场时间线</b><small>只显示项目分段，不显示音轨或波形</small></span>
              <em>{activeLabel}</em>
            </header>
            <div className="rehearsal-overview-bar" aria-label="整场分段总览">
              {timeline.segments.map((segment) => <button
                key={segment.id}
                className={`${segment.kind} ${segment.itemId === activeItemId ? 'active' : ''}`}
                style={{ flexGrow: Math.max(1, segment.endMs - segment.startMs) }}
                disabled={recordingActive}
                title={`${segment.title} · ${formatTime(segment.endMs - segment.startMs)}`}
                onClick={() => void seek(segment.startMs)}
              ><span>{segment.kind === 'countIn' ? '预备' : segment.kind === 'transition' ? '衔接' : segment.title}</span></button>)}
              {!timeline.segments.length && <span className="overview-empty">把歌曲或空白衔接拖到队列中</span>}
              <i style={{ left: `${timeline.totalDurationMs > 0 ? currentMs / timeline.totalDurationMs * 100 : 0}%` }} />
            </div>
          </section>

          <section
            className={`rehearsal-queue ${dragSource ? 'is-dragging' : ''}`}
            onDragOver={(event) => {
              if (structureLocked) return
              event.preventDefault()
              if (!event.target || !(event.target as Element).closest('.rehearsal-queue-item')) {
                const target = { itemId: null, placement: 'after' } as const
                dropTargetRef.current = target
                setDropTarget(target)
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              const source = readNativeDrag(event)
              if (source) applyDrop(source, dropTargetRef.current ?? dropTarget ?? { itemId: null, placement: 'after' })
              dragSourceRef.current = null
              dropTargetRef.current = null
              setDragSource(null)
              setDropTarget(null)
            }}
          >
            <div className="rehearsal-section-title">
              <span><b>排练队列</b><small>播放中暂停后可调整结构</small></span>
              <button className="outline-button compact" disabled={structureLocked} onClick={() => addAtEnd({ kind: 'transition' })}><Clock3 size={14} />添加衔接</button>
            </div>
            <div className="rehearsal-queue-list">
              {rehearsal.items.map((item, index) => {
                const itemPosition = timeline.segments.find((segment) => segment.itemId === item.id)
                const songDetail = item.kind === 'song' && item.songId ? songDetails.get(item.songId) ?? null : null
                const highlighted = activeItemId === item.id
                const targetClass = dropTarget?.itemId === item.id ? `drop-${dropTarget.placement}` : ''
                return <article
                  key={item.id}
                  tabIndex={initialItemId === item.id ? 0 : -1}
                  data-rehearsal-item-id={item.id}
                  className={`rehearsal-queue-item ${item.kind} ${highlighted ? 'active' : ''} ${targetClass} ${dragSource?.kind === 'existing' && dragSource.itemId === item.id ? 'dragged' : ''}`}
                  draggable={!structureLocked}
                  onDragStart={(event) => writeNativeDrag(event, { kind: 'existing', itemId: item.id })}
                  onDragEnd={clearDrag}
                  onDragOver={(event) => {
                    if (structureLocked) return
                    event.preventDefault()
                    const bounds = event.currentTarget.getBoundingClientRect()
                    const target: DropTarget = {
                      itemId: item.id,
                      placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
                    }
                    dropTargetRef.current = target
                    setDropTarget(target)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const source = readNativeDrag(event)
                    if (source) applyDrop(source, dropTargetRef.current ?? dropTarget ?? { itemId: item.id, placement: 'after' })
                    dragSourceRef.current = null
                    dropTargetRef.current = null
                    setDragSource(null)
                    setDropTarget(null)
                  }}
                >
                  <button
                    className="queue-grip"
                    aria-label={`拖动第 ${index + 1} 项；方向键可排序`}
                    disabled={structureLocked}
                    onPointerDown={(event) => {
                      if (event.pointerType !== 'mouse') startPointerDrag({ kind: 'existing', itemId: item.id })
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      moveWithKeyboard(item.id, event.key === 'ArrowUp' ? -1 : 1)
                    }}
                  ><GripVertical size={18} /></button>
                  <span className="queue-number">{String(index + 1).padStart(2, '0')}</span>
                  {item.kind === 'song'
                    ? <SongQueueItem
                      item={item}
                      song={songDetail}
                      startMs={itemPosition?.startMs ?? null}
                      structureLocked={structureLocked}
                      settingsLocked={recordingActive}
                      onSettings={() => item.songId && void openSongSettings(item.id, item.songId)}
                      onRemove={() => removeItem(item.id)}
                    />
                    : <TransitionQueueItem
                      item={item}
                      startMs={itemPosition?.startMs ?? null}
                      locked={structureLocked}
                      onDuration={(seconds) => updateTransition(item.id, seconds)}
                      onRemove={() => removeItem(item.id)}
                    />}
                </article>
              })}
              {rehearsal.items.length === 0 && <div className="rehearsal-empty-queue">
                <ListMusic size={29} />
                <b>从左侧拖入第一首歌</b>
                <span>编排单可以为空，但需要至少一个可用项目才能播放或录音。</span>
              </div>}
              <div className={`queue-drop-tail ${dropTarget?.itemId === null ? 'active' : ''}`}>拖到这里追加</div>
            </div>
          </section>

          <section className="rehearsal-recording-card">
            <div className="rehearsal-section-title">
              <span><Mic2 size={17} /><b>整场多轨录音</b><small>一次武装一条轨，不显示波形</small></span>
              <button className="outline-button compact" disabled={recordingActive} onClick={() => void createRecordingTrack()}><Plus size={14} />添加录音轨</button>
            </div>
            {rehearsal.recordingTracks.length === 0
              ? <div className="rehearsal-empty-tracks"><Mic2 size={24} /><span>添加录音轨后，可从当前整场进度开始连续叠录。</span></div>
              : <div className="rehearsal-recording-list">
                {rehearsal.recordingTracks.map((track) => <RehearsalRecordingRow
                  key={track.id}
                  track={track}
                  takes={rehearsal.recordingTakes.filter((take) => take.recordingTrackId === track.id)}
                  timelineFingerprint={timeline.fingerprint}
                  state={recordingState}
                  meter={recordingMeter}
                  locked={recordingActive}
                  canRecord={timeline.segments.length > 0 && timeline.unavailableItemIds.length === 0}
                  onRecord={() => void startRecording(track.id)}
                  onTrack={(patch) => void updateRecordingTrack(track.id, patch)}
                  onSelectTake={(takeId) => void selectTake(track.id, takeId)}
                  onUpdateTake={(takeId, patch) => void updateTake(takeId, patch)}
                  onDeleteTake={(take) => void deleteTake(take)}
                  onDuplicateRevision={(revisionId) => void duplicateRehearsal(revisionId)}
                />)}
              </div>}
          </section>
        </div>
      </section>
    </main>

    <footer className={`rehearsal-player ${recordingActive ? 'is-recording' : ''}`}>
      <div className="rehearsal-player-context">
        <span className={position.segment?.kind ?? 'idle'}>
          {recordingActive ? <Mic2 size={18} /> : position.segment?.kind === 'transition' ? <Timer size={18} /> : <ListMusic size={18} />}
        </span>
        <div><small>{recordingActive ? '正在录制整场' : playing ? '正在排练' : '排练房'}</small><b>{activeLabel}</b></div>
      </div>
      <div className="rehearsal-player-main">
        {recordingActive
          ? <div className="rehearsal-recording-controls">
            <button
              className="player-round"
              aria-label={recordingState.phase === 'paused' ? '继续录音' : '暂停录音'}
              onClick={() => void (recordingState.phase === 'paused'
                ? window.bandbuddy.rehearsals.resumeRecording()
                : window.bandbuddy.rehearsals.pauseRecording())}
            >{recordingState.phase === 'paused' ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}</button>
            <button className="player-stop-save" onClick={() => void stopRecording()}><Square size={15} fill="currentColor" />停止并保存</button>
            <button className="player-cancel-record" onClick={() => void cancelRecording()}><X size={17} />放弃</button>
          </div>
          : <div className="rehearsal-transport">
            <button aria-label="上一项" onClick={() => void seek(engine.current.previousItemStart())}><SkipBack size={18} fill="currentColor" /></button>
            <button aria-label="后退 5 秒" onClick={() => void seek(currentMs - 5000)}><RotateCcw size={17} /><small>5</small></button>
            <button className="player-round primary" aria-label={playing ? '暂停' : '播放'} onClick={() => void togglePlayback()}>
              {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <button aria-label="前进 5 秒" onClick={() => void seek(currentMs + 5000)}><FastForward size={18} /><small>5</small></button>
            <button aria-label="下一项" onClick={() => void seek(engine.current.nextItemStart())}><SkipForward size={18} fill="currentColor" /></button>
            <button aria-label="停止并归零" onClick={() => void stopPlayback()}><Square size={14} fill="currentColor" /></button>
          </div>}
        <div className="rehearsal-scrubber">
          <span>{formatTime(currentMs)}</span>
          <input
            aria-label="排练总进度"
            type="range"
            min="0"
            max={Math.max(1, timeline.totalDurationMs)}
            step="10"
            value={Math.min(currentMs, Math.max(1, timeline.totalDurationMs))}
            disabled={recordingActive || timeline.totalDurationMs <= 0}
            onChange={(event) => void seek(Number(event.target.value))}
          />
          <span>{formatTime(timeline.totalDurationMs)}</span>
        </div>
      </div>
      <div className="rehearsal-player-status">
        {recordingActive
          ? <>
            <span className={`recording-dot ${recordingState.phase === 'paused' ? 'paused' : ''}`} />
            <div><b>{recordingState.phase === 'paused' ? '录音已暂停' : recordingState.message || '录音中'}</b><small>{recordingState.preRollRemaining > 0 ? `额外预备拍 ${recordingState.preRollRemaining}` : `${recordingState.sampleRate || '—'} Hz · xrun ${recordingState.xruns}`}</small></div>
          </>
          : <>
            <Clock3 size={18} />
            <div><b>{rehearsal.items.length} 个项目</b><small>{timeline.fingerprint.slice(0, 8)} · 自动保存</small></div>
          </>}
      </div>
    </footer>
  </>
}

function SongQueueItem({
  item,
  song,
  startMs,
  structureLocked,
  settingsLocked,
  onSettings,
  onRemove
}: {
  item: Extract<RehearsalItem, { kind: 'song' }>
  song: SongDetail | null
  startMs: number | null
  structureLocked: boolean
  settingsLocked: boolean
  onSettings(): void
  onRemove(): void
}): React.JSX.Element {
  if (!song || !item.available) {
    return <div className="queue-item-body unavailable">
      <Artwork artworkUrl={item.artworkUrl} title={item.title} />
      <span className="queue-song-title"><b>{item.title}</b><small>{item.artist || '原歌曲信息不可用'}</small></span>
      <span className="queue-unavailable"><AlertTriangle size={15} />歌曲不可用</span>
      <button className="queue-delete" disabled={structureLocked} aria-label="移除不可用歌曲" onClick={onRemove}><Trash2 size={16} /></button>
    </div>
  }
  const practice = song.practice
  return <div className="queue-item-body">
    <Artwork artworkUrl={song.artworkUrl} title={song.title} />
    <span className="queue-song-title"><b>{song.title}</b><small>{song.artist || '未知艺术家'}</small></span>
    <span className="queue-time"><b>{formatTime(song.durationMs / practice.playbackRate)}</b><small>{startMs === null ? '—' : `从 ${formatTime(startMs)}`}</small></span>
    <span className="queue-setting-pills">
      <i>{practice.playbackRate.toFixed(2)}×</i>
      <i>{practice.countInBeats ? `预备 ${practice.countInBeats} 拍` : '无预备拍'}</i>
      <i className={practice.metronomeEnabled ? 'on' : ''}>节拍器 {practice.metronomeEnabled ? '开' : '关'}</i>
      <i className={practice.desktopLyricsEnabled ? 'on' : ''}>桌面歌词 {practice.desktopLyricsEnabled ? '开' : '关'}</i>
    </span>
    <button className="queue-settings" disabled={settingsLocked} onClick={onSettings}><Settings2 size={15} />设置</button>
    <button className="queue-delete" disabled={structureLocked} aria-label={`移除 ${song.title}`} onClick={onRemove}><Trash2 size={16} /></button>
  </div>
}

function TransitionQueueItem({
  item,
  startMs,
  locked,
  onDuration,
  onRemove
}: {
  item: Extract<RehearsalItem, { kind: 'transition' }>
  startMs: number | null
  locked: boolean
  onDuration(seconds: number): void
  onRemove(): void
}): React.JSX.Element {
  const seconds = Math.round(item.durationMs / 1000)
  return <div className="queue-item-body transition-body">
    <span className="transition-clock"><Timer size={21} /></span>
    <span className="queue-song-title"><b>空白衔接</b><small>{startMs === null ? '静音时间' : `从 ${formatTime(startMs)} 开始`}</small></span>
    <label className="transition-duration">
      <input
        aria-label="衔接时长（秒）"
        type="number"
        min="1"
        max="3600"
        step="1"
        value={seconds}
        disabled={locked}
        onChange={(event) => onDuration(Number(event.target.value))}
      />
      <span>秒</span>
    </label>
    <span className="transition-shortcuts">
      {[5, 10, 15, 30].map((value) => <button key={value} disabled={locked} className={seconds === value ? 'active' : ''} onClick={() => onDuration(value)}>{value}s</button>)}
    </span>
    <button className="queue-delete" disabled={locked} aria-label="移除衔接" onClick={onRemove}><Trash2 size={16} /></button>
  </div>
}

function RehearsalRecordingRow({
  track,
  takes,
  timelineFingerprint,
  state,
  meter,
  locked,
  canRecord,
  onRecord,
  onTrack,
  onSelectTake,
  onUpdateTake,
  onDeleteTake,
  onDuplicateRevision
}: {
  track: RehearsalRecordingTrackState
  takes: RehearsalRecordingTake[]
  timelineFingerprint: string
  state: RehearsalRecordingState
  meter: RecordingMeter
  locked: boolean
  canRecord: boolean
  onRecord(): void
  onTrack(patch: Partial<Pick<RehearsalRecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>): void
  onSelectTake(takeId: string | null): void
  onUpdateTake(takeId: string, patch: { name?: string; alignmentOffsetMs?: number }): void
  onDeleteTake(take: RehearsalRecordingTake): void
  onDuplicateRevision(revisionId: string): void
}): React.JSX.Element {
  const activeTake = takes.find((take) => take.id === track.activeTakeId) ?? null
  const mismatch = Boolean(activeTake && activeTake.timelineFingerprint !== timelineFingerprint)
  const activeRecording = locked && state.recordingTrackId === track.id
  const peak = activeRecording ? Math.max(0, ...meter.peak) : 0
  const renameTake = (): void => {
    if (!activeTake) return
    const name = window.prompt('Take 名称', activeTake.name)?.trim()
    if (name && name !== activeTake.name) onUpdateTake(activeTake.id, { name })
  }
  return <article className={`rehearsal-recording-row ${activeRecording ? 'active' : ''} ${mismatch ? 'mismatch' : ''}`}>
    <span className="record-track-icon"><Mic2 size={18} /><i style={{ height: `${Math.min(100, peak * 100)}%` }} /></span>
    <input
      className="record-track-name"
      aria-label="录音轨名称"
      defaultValue={track.name}
      key={`${track.id}:${track.name}`}
      disabled={locked}
      onBlur={(event) => {
        const name = event.target.value.trim()
        if (name && name !== track.name) onTrack({ name })
      }}
    />
    <span className="record-track-ms">
      <button className={track.muted ? 'active' : ''} disabled={locked || !activeTake} onClick={() => onTrack({ muted: !track.muted, ...(!track.muted ? { solo: false } : {}) })}>M</button>
      <button className={track.solo ? 'active' : ''} disabled={locked || !activeTake} onClick={() => onTrack({ solo: !track.solo, ...(!track.solo ? { muted: false } : {}) })}>S</button>
    </span>
    <label className="record-track-gain">
      <input type="range" min="-60" max="6" step=".5" value={track.gainDb} disabled={locked || !activeTake} onChange={(event) => onTrack({ gainDb: Number(event.target.value) })} />
      <small>{gainLabel(track.gainDb)}</small>
    </label>
    <select value={activeTake?.id ?? ''} disabled={locked || takes.length === 0} onChange={(event) => onSelectTake(event.target.value || null)}>
      <option value="">无活动 Take</option>
      {takes.map((take) => <option key={take.id} value={take.id}>{take.name}{take.timelineFingerprint === timelineFingerprint ? '' : ' · 旧版本'}</option>)}
    </select>
    {!locked
      ? <button className="rehearsal-arm" disabled={!canRecord} onClick={onRecord}><Circle size={14} fill="currentColor" />录制</button>
      : <span className="rehearsal-arm-status">{activeRecording ? state.phase === 'paused' ? '已暂停' : '录制中' : '未武装'}</span>}
    {activeTake && <div className="record-take-details">
      <audio controls preload="metadata" src={activeTake.previewMediaUrl} />
      <button disabled={locked} title="重命名 Take" onClick={renameTake}><Pencil size={13} /></button>
      <label>对齐
        <input
          type="number"
          min="-1000"
          max="1000"
          step="1"
          disabled={locked}
          defaultValue={activeTake.alignmentOffsetMs}
          key={`${activeTake.id}:${activeTake.alignmentOffsetMs}`}
          onBlur={(event) => onUpdateTake(activeTake.id, { alignmentOffsetMs: clamp(Number(event.target.value), -1000, 1000) })}
        /> ms
      </label>
      <button disabled={locked} title="删除 Take" onClick={() => onDeleteTake(activeTake)}><Trash2 size={13} /></button>
      {mismatch && <span className="take-version-warning">
        <AlertTriangle size={13} />时间线版本不匹配，仅可单独试听
        <button disabled={locked} onClick={() => onDuplicateRevision(activeTake.revisionId)}>从此版本新建编排单</button>
      </span>}
    </div>}
    {meter.clipped && activeRecording && <em className="recording-clip">CLIP</em>}
  </article>
}

function Artwork({ artworkUrl, title }: { artworkUrl: string | null; title: string }): React.JSX.Element {
  return <span className="rehearsal-artwork">
    {artworkUrl
      ? <img src={artworkUrl} alt="" />
      : <><span className="vinyl-grooves" /><i>{title.slice(0, 1).toLocaleUpperCase()}</i></>}
  </span>
}
