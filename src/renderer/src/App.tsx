import { allowAudioAction, getRecordingSession, isRecordingLocked, publishRecordingState, registerRecordingControls, useRecordingSession } from './recording-session.js'
import { BackgroundRecording } from './components/BackgroundRecording.js'
import { claimAudioSession, isAudioSessionCurrent, pauseAudioSession, releaseAudioSession, useAudioSession } from './audio-session.js'
import { BackgroundTransport } from './components/BackgroundTransport.js'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Library, Plus } from 'lucide-react'
import {
  GUITAR_SPLIT_STEMS,
  getStemTypeFromTrackOrderKey,
  isStemVisible,
  normalizeSelectedStemForGuitarMode,
  normalizeTrackOrder,
  type AppSettings,
  type LibraryPageResult,
  type JobRecord,
  type DesktopLyricsPayload,
  type PracticeState,
  type RecordingState,
  type RecordingTrackState,
  type SongDetail,
  type SongSummary,
  type StemType
} from '@shared/domain.js'
import { lyricFrameAt } from '@shared/lyrics.js'
import { nextLoopState, restartPositionMs } from '@shared/playback.js'
import { MultiTrackAudioEngine } from './audio-engine.js'
import { confirmAction } from './components/ui/confirm.js'
import { Header } from './components/Header.js'
import { PlayerBar } from './components/PlayerBar.js'
import { fixtureDetail, fixtureSongs } from './fixtures.js'
import { usePlayerStore, useRecordingMeterStore } from './player-store.js'
import { LibraryPage } from './pages/LibraryPage.js'
const PracticeRoom = lazy(() => import('./pages/PracticeRoom.js').then((module) => ({ default: module.PracticeRoom })))
const RehearsalRoom = lazy(() => import('./pages/RehearsalRoom.js').then((module) => ({ default: module.RehearsalRoom })))
const ArsenalPage = lazy(() => import('./pages/ArsenalPage.js').then((module) => ({ default: module.ArsenalPage })))
import { loadStartupAudioSettings, reconcileStartupAudioSettings } from './startup-audio-devices.js'
import { clamp, isCancellationError, silenceToggle, toUserErrorMessage } from './utils.js'
import './playback-media.css'

const ImportDialog = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.ImportDialog })))
const ExportDialog = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.ExportDialog })))
const MetadataDialog = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.MetadataDialog })))
const AppearanceDialog = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.AppearanceDialog })))
const SettingsDrawer = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.SettingsDrawer })))
const TasksDrawer = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.TasksDrawer })))
const SongActionsDialog = lazy(() => import('./components/Dialogs.js').then((m) => ({ default: m.SongActionsDialog })))
const WoodshedPage = lazy(() => import('./pages/WoodshedPage.js'))

const previewParams = new URLSearchParams(location.search)
const fixtureMode = import.meta.env.DEV && previewParams.has('fixtures')
const fixtureGuitarPreview = import.meta.env.DEV ? previewParams.get('guitarSplit') : null

export default function App(): React.JSX.Element {
  const client = useQueryClient()
  const [audioEngine] = useState(() => new MultiTrackAudioEngine())
  const engine = useRef(audioEngine)
  const songLoadGeneration = useRef(0)
  const [view, setView] = useState<'library' | 'practice' | 'woodshed' | 'rehearsal' | 'arsenal'>('library')
  const [activeRehearsalId, setActiveRehearsalId] = useState<string | null>(null)
  const [rehearsalReturn, setRehearsalReturn] = useState<{
    rehearsalId: string
    itemId: string
    scrollTop: number
  } | null>(null)
  const audioSession = useAudioSession()
  const recordingSession = useRecordingSession()
  const globallyRecording = Boolean(recordingSession)
  useEffect(() => { if (globallyRecording) pauseAudioSession() }, [globallyRecording])
  const recordingStartGeneration = useRef(0)
  const recordingStateRevision = useRef(0)
  const recordingOperation = useRef<number | null>(null)
  const recordingStartPending = useRef(false)
  const nativeRecordingRequested = useRef(false)
  const recordingCancelRequested = useRef(false)
  const authoritativeRecordingState = useRef<RecordingState | null>(null)
  const [visitedRooms, setVisitedRooms] = useState({ rehearsal: false, woodshed: false })
  useEffect(() => { if (view === 'rehearsal' || view === 'woodshed') setVisitedRooms(previous => previous[view] ? previous : { ...previous, [view]: true }) }, [view])
  const [rehearsalRecordingLocked, setRehearsalRecordingLocked] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [recentOffset, setRecentOffset] = useState(0)
  const [filter, setFilter] = useState<'all' | 'favorite' | 'processing' | 'recent'>('all')
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [importOpen, setImportOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [metadataSong, setMetadataSong] = useState<SongDetail | null>(null)
  const [songActionsOpen, setSongActionsOpen] = useState(false)
  const [actionSong, setActionSong] = useState<SongSummary | null>(null)
  const [toast, setToast] = useState('')
  const [guitarSplitJob, setGuitarSplitJob] = useState<{ songId: string; jobId: string } | null>(null)
  const [guitarSplitReadySongId, setGuitarSplitReadySongId] = useState<string | null>(null)
  const [fixtureGuitarReadyDismissed, setFixtureGuitarReadyDismissed] = useState(false)
  const [countInRemaining, setCountInRemaining] = useState(0)
  const [availableOutputChannelPairs, setAvailableOutputChannelPairs] = useState(fixtureMode ? 6 : 1)
  const [recordingState, setRecordingState] = useState<RecordingState>({
    target: 'song',
    phase: 'idle', sessionId: null, songId: null, recordingTrackId: null, sourcePositionMs: 0, countInRemaining: 0,
    sampleRate: 0, bufferFrames: 0, latencyMs: 0, xruns: 0, splitDevices: false, message: '', error: null
  })
  const setRecordingMeter = useRecordingMeterStore.getState().setMeter
  const recordingWasActive = useRef(false)
  const viewRef = useRef(view)

  const song = usePlayerStore((state) => state.song)
  const practice = usePlayerStore((state) => state.practice)
  const playing = usePlayerStore((state) => state.playing)
  const selectedStem = usePlayerStore((state) => state.selectedStem)
  const loadSong = usePlayerStore((state) => state.loadSong)
  const updateSongDetails = usePlayerStore((state) => state.updateSongDetails)
  const unloadSong = usePlayerStore((state) => state.unload)
  const setPlaying = usePlayerStore((state) => state.setPlaying)
  const setCurrentMs = usePlayerStore((state) => state.setCurrentMs)
  const patchPractice = usePlayerStore((state) => state.patchPractice)
  const patchTrack = usePlayerStore((state) => state.patchTrack)
  const setSelectedStem = usePlayerStore((state) => state.setSelectedStem)
  const desktopLyricsVisible = (!audioSession || audioSession.owner === 'practice') && (view === 'practice' || playing)
    && Boolean(song?.lyrics?.cues.length && practice?.desktopLyricsEnabled)
  const lastDesktopLyricsUpdate = useRef({ at: 0, signature: '' })

  useEffect(() => { viewRef.current = view }, [view])

  const listSongs = async (search: string, selection: typeof filter, start: number, limit: number) => {
    if (!fixtureMode) return window.bandbuddy.library.listPage({ query: search, filter: selection, offset: start, limit })
    const normalized = search.trim().toLocaleLowerCase()
    const items = fixtureSongs.filter((item) => !normalized || `${item.title} ${item.artist}`.toLocaleLowerCase().includes(normalized))
      .filter((item) => selection === 'favorite' ? item.favorite : selection === 'processing' ? item.status !== 'ready' : selection === 'recent' ? item.lastPracticedAt !== null : true)
    if (selection === 'recent') items.sort((a, b) => (b.lastPracticedAt ?? '').localeCompare(a.lastPracticedAt ?? ''))
    return { items: items.slice(start, start + limit), total: items.length, offset: start, limit }
  }
  const songsQuery = useQuery({
    queryKey: ['songs', 'page', query, filter, offset, fixtureMode],
    queryFn: () => listSongs(query, filter, offset, 50),
    enabled: view === 'library'
  })
  const recentQuery = useQuery({
    queryKey: ['songs', 'recent', recentOffset, fixtureMode],
    queryFn: () => listSongs('', 'recent', recentOffset, 3),
    enabled: view === 'library'
  })
  useEffect(() => {
    if (songsQuery.data && offset >= songsQuery.data.total && offset > 0) setOffset(Math.max(0, Math.floor((songsQuery.data.total - 1) / 50) * 50))
  }, [songsQuery.data, offset])
  useEffect(() => {
    if (recentQuery.data && recentOffset >= recentQuery.data.total && recentOffset > 0) setRecentOffset(Math.max(0, Math.floor((recentQuery.data.total - 1) / 3) * 3))
  }, [recentQuery.data, recentOffset])
  const tasksQuery = useQuery({ queryKey: ['tasks'], queryFn: () => window.bandbuddy.tasks.list() })
  const runtimeQuery = useQuery({ queryKey: ['runtime'], queryFn: () => window.bandbuddy.runtime.get() })
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fixtureMode ? () => window.bandbuddy.settings.get() : loadStartupAudioSettings,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const startupScanStarted = useRef(false)
  useEffect(() => {
    const initial = settingsQuery.data
    if (!initial || fixtureMode || startupScanStarted.current || globallyRecording) return
    startupScanStarted.current = true
    void reconcileStartupAudioSettings(initial, () => !isRecordingLocked()).then((latest) => {
      if (client.getQueryData(['settings']) === initial) client.setQueryData(['settings'], latest)
    }).catch(() => { /* Playback already falls back to the system device; a scan never blocks the library. */ })
  }, [client, settingsQuery.data, globallyRecording])
  const interactiveMeasured = useRef(false)
  useEffect(() => {
    if (view !== 'library' || !songsQuery.isSuccess || interactiveMeasured.current) return
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        interactiveMeasured.current = true
        performance.mark('bandbuddy:library-interactive')
        console.info(`BAND_BUDDY_METRIC ${JSON.stringify({ phase: 'library-interactive', navigationMs: performance.now() })}`)
      })
    })
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame) }
  }, [view, songsQuery.isSuccess])

  useEffect(() => {
    const recordingRevision = recordingStateRevision.current
    void window.bandbuddy.recording.state().then(value => { if (recordingRevision === recordingStateRevision.current) { authoritativeRecordingState.current = value; setRecordingState(value); publishRecordingState('practice', value) } })
    const onRecordingBlocked = (event: Event): void => setToast((event as CustomEvent<string>).detail)
    window.addEventListener('bandbuddy:recording-blocked', onRecordingBlocked)
    const unsubscribe = [
      window.bandbuddy.library.onChanged(() => void client.invalidateQueries({ queryKey: ['songs'] })),
      window.bandbuddy.library.onUpdated((update) => {
        if (update.kind !== 'updated' || !update.song) { void client.invalidateQueries({ queryKey: ['songs'] }); return }
        const summary = update.song
        for (const [key, page] of client.getQueriesData<LibraryPageResult>({ queryKey: ['songs'] })) {
          if (!page) continue
          const index = page.items.findIndex((item) => item.id === update.songId)
          if (index < 0) {
            if (key[1] === 'recent') void client.invalidateQueries({ queryKey: key, exact: true })
            continue
          }
          const items = page.items.map((item) => item.id === update.songId ? summary : item)
          if (key[1] === 'recent') items.sort((a, b) => (b.lastPracticedAt ?? '').localeCompare(a.lastPracticedAt ?? ''))
          client.setQueryData(key, { ...page, items })
        }
      }),
      window.bandbuddy.tasks.onChanged((job) => {
        if (!job) {
          void client.invalidateQueries({ queryKey: ['tasks'] })
          return
        }
        // A delayed list refresh must not overwrite the newer progress/terminal event.
        void client.cancelQueries({ queryKey: ['tasks'], exact: true })
        if (!client.getQueryData<JobRecord[]>(['tasks'])) {
          void client.invalidateQueries({ queryKey: ['tasks'], exact: true })
          return
        }
        client.setQueryData<JobRecord[]>(['tasks'], (previous) => {
          if (!previous) return previous
          if (previous.some((item) => item.id === job.id)) return previous.map((item) => item.id === job.id ? job : item)
          return [job, ...previous].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        })
      }),
      window.bandbuddy.runtime.onChanged((value) => {
        // A delayed startup read must not replace this newer authoritative event.
        void client.cancelQueries({ queryKey: ['runtime'], exact: true })
        client.setQueryData(['runtime'], value)
      }),
      window.bandbuddy.settings.onChanged((value) => {
        void client.cancelQueries({ queryKey: ['settings'], exact: true })
        client.setQueryData(['settings'], value)
      }),
      window.bandbuddy.recording.onState((value) => {
        recordingStateRevision.current++
        authoritativeRecordingState.current = value
        if (!(recordingStartPending.current && recordingCancelRequested.current && value.phase === 'idle')) publishRecordingState('practice', value)
        if (recordingStartPending.current && recordingCancelRequested.current && !['idle', 'failed', 'stopping'].includes(value.phase)) void window.bandbuddy.recording.cancel().catch(() => undefined)
        setRecordingState((previous) => Object.keys(value).every((key) => key === 'sourcePositionMs' || previous[key as keyof RecordingState] === value[key as keyof RecordingState]) ? previous : value)
        setCountInRemaining(value.countInRemaining)
        if (['countIn', 'armed', 'recording', 'stopping'].includes(value.phase)) setCurrentMs(value.sourcePositionMs)
        if (value.error && !isCancellationError(value.error)) {
          setToast(toUserErrorMessage(value.error, '录音失败，请检查声卡后重试'))
        }
      }),
      window.bandbuddy.recording.onMeter(setRecordingMeter)
    ]
    return () => { unsubscribe.forEach((stop) => stop()); window.removeEventListener('bandbuddy:recording-blocked', onRecordingBlocked); publishRecordingState('practice', { phase: 'idle' }) }
  }, [client])

  useEffect(() => {
    let subscribed = true
    const unsubscribe = window.bandbuddy.library.onGuitarSplitCompleted((songId) => {
      void (async () => {
        void client.invalidateQueries({ queryKey: ['songs'] })
        void client.invalidateQueries({ queryKey: ['tasks'] })
        const current = usePlayerStore.getState()
        if (current.song?.id !== songId) return
        const updated = await window.bandbuddy.library.get(songId)
        if (!updated || !subscribed) return
        await engine.current.updateStemSources(updated)
        if (!subscribed) return
        const latest = usePlayerStore.getState()
        if (latest.song?.id !== songId) return
        updateSongDetails(updated)
        if (updated.practice.guitarSplitEnabled && latest.practice && !latest.practice.guitarSplitEnabled) {
          patchPractice({
            guitarSplitEnabled: true,
            selectedStem: normalizeSelectedStemForGuitarMode(latest.selectedStem, true) ?? 'acoustic_guitar'
          })
        }
        setGuitarSplitJob((active) => active?.songId === songId ? null : active)
        if (viewRef.current === 'practice') setGuitarSplitReadySongId(songId)
      })().catch(() => {
        if (subscribed) setToast('吉他分轨已完成，但刷新音轨失败；重新进入练习室即可加载')
      })
    })
    return () => { subscribed = false; unsubscribe() }
  }, [client, patchPractice, updateSongDetails])

  useEffect(() => {
    if (!guitarSplitReadySongId) return
    const timer = window.setTimeout(() => setGuitarSplitReadySongId(null), 7_000)
    return () => window.clearTimeout(timer)
  }, [guitarSplitReadySongId])

  useEffect(() => {
    engine.current.onTime(setCurrentMs)
    engine.current.onEnded(() => { releaseAudioSession('practice'); setPlaying(false); setCountInRemaining(0); setCurrentMs(0) })
    engine.current.onError(() => {
      patchPractice({ pitchSemitones: 0 })
      setToast('实时升降调初始化失败，已恢复原调；请重试或检查音频组件')
    })
    return () => { engine.current.destroy(); releaseAudioSession('practice') }
  }, [patchPractice, setCurrentMs, setPlaying])

  useEffect(() => {
    if (practice) engine.current.applyPractice(practice)
  }, [practice])

  const pausePractice = (): void => { engine.current.pause(); releaseAudioSession('practice') }
  const playPractice = async (countIn: 0 | 4 | 8 = 0): Promise<boolean> => {
    if (!allowAudioAction()) return false
    const session = claimAudioSession('practice', usePlayerStore.getState().song?.title ?? '歌曲练习', () => {
      pausePractice(); setPlaying(false); setCountInRemaining(0); releaseAudioSession('practice')
    })
    try {
      const started = await engine.current.play(countIn, setCountInRemaining)
      if (!started) releaseAudioSession('practice', session)
      return isAudioSessionCurrent(session) ? started : usePlayerStore.getState().playing
    } catch (error) { releaseAudioSession('practice', session); throw error }
  }

  const saveNow = async (): Promise<void> => {
    const state = usePlayerStore.getState()
    if (!state.practice || !state.song || fixtureMode) return
    await window.bandbuddy.library.savePractice({ ...state.practice, positionMs: state.currentMs, updatedAt: new Date().toISOString() })
  }

  useEffect(() => {
    if (!practice || fixtureMode) return
    const timer = setTimeout(() => void saveNow(), 500)
    return () => clearTimeout(timer)
  }, [practice])

  useEffect(() => {
    if (!playing || fixtureMode) return
    const timer = setInterval(() => void saveNow(), 5000)
    return () => clearInterval(timer)
  }, [playing])

  useEffect(() => window.bandbuddy.window.onHidden(() => void saveNow()), [])

  useEffect(() => {
    if (audioSession?.owner === 'rehearsal' || (!audioSession && view === 'rehearsal')) return
    void window.bandbuddy.desktopLyrics.setVisible(desktopLyricsVisible).catch(() => {
      if (!desktopLyricsVisible) return
      patchPractice({ desktopLyricsEnabled: false })
      setToast('无法打开桌面歌词，请重启应用后重试')
    })
  }, [desktopLyricsVisible, patchPractice, view, audioSession?.owner])

  useEffect(() => () => {
    void window.bandbuddy.desktopLyrics.setVisible(false)
  }, [])

  useEffect(() => {
    if (!desktopLyricsVisible || !song?.lyrics) return
    const lyrics = song.lyrics
    const update = (): void => {
      const { currentMs, playing } = usePlayerStore.getState()
      const frame = lyricFrameAt(lyrics.cues, currentMs)
      const currentLines = (frame.current?.lines ?? [
        song.artist ? `${song.title} · ${song.artist}` : song.title
      ]).slice(0, 4).map((line) => line.slice(0, 1000))
      const nextLines = (frame.next?.lines ?? []).slice(0, 4).map((line) => line.slice(0, 1000))
      const signature = `${song.id}\n${playing}\n${currentLines.join('\n')}\n${nextLines.join('\n')}`
      const now = performance.now()
      if (signature === lastDesktopLyricsUpdate.current.signature && now - lastDesktopLyricsUpdate.current.at < 80) return
      lastDesktopLyricsUpdate.current = { at: now, signature }
      const payload: DesktopLyricsPayload = {
        title: song.title,
        artist: song.artist,
        currentLines,
        nextLines,
        progress: frame.progress,
        playing
      }
      window.bandbuddy.desktopLyrics.update(payload)
    }
    update()
    return usePlayerStore.subscribe(update)
  }, [desktopLyricsVisible, song])

  useEffect(() => {
    const active = !['idle', 'failed'].includes(recordingState.phase)
    if (active) recordingWasActive.current = true
    else if (recordingState.phase === 'idle' && recordingWasActive.current) {
      recordingWasActive.current = false
      const current = usePlayerStore.getState().song
      if (current && !fixtureMode) {
        void window.bandbuddy.library.get(current.id).then((updated) => {
          if (updated) void replaceCurrentSong(updated)
        })
      }
    }
  }, [recordingState.phase])

  const openSong = async (summaryOrId: SongSummary | string, autoPlay = false): Promise<void> => {
    if (!allowAudioAction()) return
    const generation = ++songLoadGeneration.current
    if (generation !== songLoadGeneration.current) return
    const summary = typeof summaryOrId === 'string' ? fixtureSongs.find((item) => item.id === summaryOrId) : summaryOrId
    const detail = fixtureMode && summary ? fixtureDetail(summary) : await window.bandbuddy.library.get(typeof summaryOrId === 'string' ? summaryOrId : summaryOrId.id)
    if (generation !== songLoadGeneration.current || isRecordingLocked()) return
    if (!detail) { setToast('歌曲不存在或已被删除'); return }
    pausePractice()
    setCountInRemaining(0)
    loadSong(detail)
    setView('practice')
    try {
      await engine.current.load(detail, settingsQuery.data?.audioOutputDeviceId, settingsQuery.data?.latencyMode)
      if (generation !== songLoadGeneration.current) return
      setAvailableOutputChannelPairs(fixtureMode ? 6 : engine.current.availableOutputChannelPairs)
    } catch {
      if (generation !== songLoadGeneration.current) return
      setToast('无法加载音频，请检查音频文件或输出设备')
      return
    }
    const loadedPractice = usePlayerStore.getState().practice
    if (loadedPractice) engine.current.applyPractice(loadedPractice, true)
    if (autoPlay) {
      try {
        const started = await playPractice(loadedPractice?.countInBeats ?? 0)
        if (generation === songLoadGeneration.current) setPlaying(started)
      } catch {
        if (generation !== songLoadGeneration.current) return
        setCountInRemaining(0)
        setPlaying(false)
        setToast('音频暂时无法播放，请检查文件是否完整')
      }
    }
  }

  const togglePlayback = async (): Promise<void> => {
    if (!allowAudioAction()) return
    if (!song || !['idle', 'failed'].includes(recordingState.phase)) return
    if (playing || countInRemaining > 0) {
      pausePractice()
      setCountInRemaining(0)
      setPlaying(false)
      patchPractice({ positionMs: usePlayerStore.getState().currentMs })
      await saveNow()
    }
    else {
      try {
        const countIn = practice?.countInBeats ?? 0
        if (countIn > 0) setCountInRemaining(countIn)
        const started = await playPractice(countIn)
        setPlaying(started)
      } catch {
        setCountInRemaining(0)
        setPlaying(false)
        setToast('播放失败，请检查音频文件或输出设备')
      }
    }
  }

  const seek = (milliseconds: number): void => {
    if (!allowAudioAction()) return
    if (!song || !['idle', 'failed'].includes(recordingState.phase)) return
    const position = clamp(milliseconds, 0, song.durationMs)
    engine.current.seek(position)
    setCurrentMs(position)
    patchPractice({ positionMs: position })
  }

  const playFrom = async (milliseconds: number): Promise<void> => {
    const state = usePlayerStore.getState()
    if (!state.song || !state.practice || !['idle', 'failed'].includes(recordingState.phase)) return
    pausePractice()
    setCountInRemaining(0)
    setPlaying(false)
    seek(milliseconds)
    // Apply a newly completed A-B range before restarting; the React effect
    // may not have committed yet when this handler is invoked.
    engine.current.applyPractice(usePlayerStore.getState().practice!)
    try {
      const started = await playPractice()
      if (started && usePlayerStore.getState().song?.id === state.song.id) setPlaying(true)
    } catch {
      setToast('播放失败，请检查音频文件或输出设备')
    }
  }

  const restartPlayback = (): void => {
    if (!allowAudioAction()) return
    const state = usePlayerStore.getState()
    if (state.practice) void playFrom(restartPositionMs(state.practice))
  }

  const cycleLoop = (): void => {
    if (!allowAudioAction()) return
    const state = usePlayerStore.getState()
    if (!state.song || !state.practice || !['idle', 'failed'].includes(recordingState.phase)) return
    const next = nextLoopState(state.practice, state.currentMs, state.song.durationMs)
    if (!next) {
      setToast(state.practice.loopStartMs === null
        ? 'A 点需在歌曲结束前，请先向前调整播放位置'
        : 'B 点需要晚于 A 点至少 0.1 秒；可继续播放或拖动进度，Esc 清除')
      return
    }
    patchPractice(next)
    if (next.loopEnabled) void playFrom(next.loopStartMs!)
  }

  const replaceCurrentSong = async (updated: SongDetail, preserveLocalPractice = true): Promise<void> => {
    if (usePlayerStore.getState().song?.id !== updated.id) return
    const generation = ++songLoadGeneration.current
    const wasPlaying = usePlayerStore.getState().playing
    pausePractice()
    const nextSong = {
      ...updated,
      practice: preserveLocalPractice ? practice ?? updated.practice : updated.practice
    }
    loadSong(nextSong)
    try {
      await engine.current.load(nextSong, settingsQuery.data?.audioOutputDeviceId, settingsQuery.data?.latencyMode)
      if (generation !== songLoadGeneration.current) return
      setAvailableOutputChannelPairs(fixtureMode ? 6 : engine.current.availableOutputChannelPairs)
    } catch {
      if (generation !== songLoadGeneration.current) return
      setToast('无法加载音频，请检查音频文件或输出设备')
      return
    }
    if (wasPlaying) { const started = await playPractice(); if (generation === songLoadGeneration.current) setPlaying(started) }
  }

  const refreshCurrentSong = async (): Promise<void> => {
    const current = usePlayerStore.getState().song
    if (!current || fixtureMode) return
    const updated = await window.bandbuddy.library.get(current.id)
    if (updated) await replaceCurrentSong(updated)
  }

  const startRecording = async (recordingTrackId: string): Promise<void> => {
    const state = usePlayerStore.getState()
    if (!state.song || !state.practice || fixtureMode || !allowAudioAction()) return
    const generation = ++recordingStartGeneration.current
    recordingStateRevision.current++
    recordingOperation.current = generation
    recordingStartPending.current = true
    nativeRecordingRequested.current = false
    recordingCancelRequested.current = false
    publishRecordingState('practice', { phase: 'starting', message: '正在准备录音…' })
    pauseAudioSession()
    pausePractice()
    setPlaying(false)
    setCountInRemaining(0)
    setRecordingMeter({ peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: state.currentMs, recording: false })
    try {
      await saveNow()
      if (generation !== recordingStartGeneration.current) return
      nativeRecordingRequested.current = true
      await window.bandbuddy.recording.start({
        songId: state.song.id,
        recordingTrackId,
        positionMs: state.currentMs,
        practice: state.practice
      })
      if (generation !== recordingStartGeneration.current) await window.bandbuddy.recording.cancel()
    } catch (error) {
      if (generation === recordingStartGeneration.current) publishRecordingState('practice', { phase: 'failed' })
      if (generation === recordingStartGeneration.current && !isCancellationError(error)) setToast(toUserErrorMessage(error, '录音失败，请检查声卡后重试'))
    } finally {
      if (recordingOperation.current !== generation) return
      recordingOperation.current = null
      recordingStartPending.current = false
      nativeRecordingRequested.current = false
      if (recordingCancelRequested.current) {
        const latest = await window.bandbuddy.recording.state().catch(() => authoritativeRecordingState.current)
        if (latest) { publishRecordingState('practice', latest); setRecordingState(latest) }
        else publishRecordingState('practice', { phase: 'idle' })
      }
    }
  }

  const stopRecording = async (): Promise<void> => {
    if (fixtureMode || getRecordingSession()?.owner !== 'practice') return
    recordingStateRevision.current++
    recordingStartGeneration.current++
    try {
      await window.bandbuddy.recording.stop()
      await refreshCurrentSong()
    } catch (error) {
      setToast(toUserErrorMessage(error, '停止录音失败，请重试'))
    }
  }

  const cancelRecording = async (): Promise<void> => {
    if (fixtureMode || getRecordingSession()?.owner !== 'practice') return
    recordingStateRevision.current++
    recordingStartGeneration.current++
    recordingCancelRequested.current = recordingStartPending.current
    if (recordingStartPending.current && !nativeRecordingRequested.current) {
      recordingOperation.current = null
      recordingStartPending.current = false
      publishRecordingState('practice', authoritativeRecordingState.current ?? { phase: 'idle' })
      return
    }
    await window.bandbuddy.recording.cancel()
    const latest = await window.bandbuddy.recording.state()
    publishRecordingState('practice', recordingStartPending.current ? { phase: 'starting', message: '正在取消录音准备…' } : latest)
    setRecordingState(latest)
    setRecordingMeter({ peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: usePlayerStore.getState().currentMs, recording: false })
  }

  const recordingControls = useRef({ stop: stopRecording, cancel: cancelRecording })
  recordingControls.current = { stop: stopRecording, cancel: cancelRecording }
  useEffect(() => registerRecordingControls('practice', { stop: () => recordingControls.current.stop(), cancel: () => recordingControls.current.cancel() }), [])

  const createRecordingTrack = async (): Promise<void> => {
    if (!allowAudioAction()) return
    if (!song || fixtureMode) return
    try {
      await window.bandbuddy.recording.createTrack(song.id)
      await refreshCurrentSong()
    } catch (error) {
      setToast(toUserErrorMessage(error, '无法创建录音轨，请重试'))
    }
  }

  const selectTake = async (recordingTrackId: string, takeId: string | null): Promise<void> => {
    if (!allowAudioAction()) return
    if (fixtureMode) return
    await window.bandbuddy.recording.selectTake({ recordingTrackId, takeId })
    await refreshCurrentSong()
  }

  const updateTake = async (takeId: string, patch: { name?: string; alignmentOffsetMs?: number }): Promise<void> => {
    if (!allowAudioAction()) return
    if (fixtureMode) return
    await window.bandbuddy.recording.updateTake({ takeId, ...patch })
    await refreshCurrentSong()
  }

  const deleteTake = async (takeId: string): Promise<void> => {
    if (!allowAudioAction()) return
    if (fixtureMode || !await confirmAction({ title: '删除 Take', message: '确定删除这个 Take？此操作无法撤销。', destructive: true })) return
    await window.bandbuddy.recording.deleteTake(takeId)
    await refreshCurrentSong()
  }

  const updateRecordingTrack = async (
    recordingTrackId: string,
    patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): Promise<void> => {
    if (!allowAudioAction() || fixtureMode) return
    await window.bandbuddy.recording.updateTrack({ recordingTrackId, patch })
    await refreshCurrentSong()
  }

  const importLyrics = async (): Promise<void> => {
    const selected = actionSong
    if (!selected) return
    try {
      const updated = await window.bandbuddy.library.importLyrics(selected.id)
      if (!updated) return
      updateSongDetails(updated)
      void client.invalidateQueries({ queryKey: ['songs'] })
      setToast(`已导入 ${updated.lyrics?.fileName ?? 'LRC 歌词'} · ${updated.lyrics?.cues.length ?? 0} 句`)
    } catch (error) {
      setToast(toUserErrorMessage(error, '歌词导入失败，请检查 LRC 文件后重试'))
    }
  }

  const setGuitarSplitMode = async (enabled: boolean): Promise<void> => {
    if (!allowAudioAction()) return
    const state = usePlayerStore.getState()
    if (!state.song || !state.practice) return
    const nextSelected = normalizeSelectedStemForGuitarMode(state.selectedStem, enabled) ?? 'vocals'
    if (!enabled || GUITAR_SPLIT_STEMS.every((type) => state.song!.stems.some((stem) => stem.type === type))) {
      patchPractice({ guitarSplitEnabled: enabled, selectedStem: nextSelected })
      setSelectedStem(nextSelected)
      return
    }
    if (!state.song.sourceFormat || state.song.sourceFormat === 'existing-stems') {
      setToast('这首歌没有原始音频，无法生成吉他细分轨；现有音轨仍可继续播放和导出')
      return
    }
    if (!await confirmAction({ title: '生成吉他细分轨', message: '这首歌需要重新分轨才能生成木吉他、Lead 和 Rhythm。完成前会继续使用当前分轨，是否继续？' })) return
    try {
      await saveNow()
      if (fixtureMode) {
        patchPractice({ guitarSplitEnabled: true, selectedStem: nextSelected })
        setSelectedStem(nextSelected)
        return
      }
      const jobId = await window.bandbuddy.library.requestGuitarSplit(state.song.id)
      if (!jobId) {
        const updated = await window.bandbuddy.library.get(state.song.id)
        if (updated) await replaceCurrentSong(updated, false)
        return
      }
      setGuitarSplitJob({ songId: state.song.id, jobId })
      updateSongDetails({ ...state.song, guitarSplitStatus: 'pending' })
      setTasksOpen(true)
      if (runtimeQuery.data?.status !== 'ready') setSettingsOpen(true)
      setToast('正在生成吉他细分轨；完成后会自动通知')
    } catch (error) {
      setToast(toUserErrorMessage(error, '无法开始吉他分轨，请重试'))
    }
  }

  useEffect(() => {
    if (!guitarSplitJob) return
    const job = tasksQuery.data?.find((candidate) => candidate.id === guitarSplitJob.jobId)
    if (!job) return
    if (job.status === 'completed') {
      setGuitarSplitJob(null)
    } else if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      setGuitarSplitJob(null)
      const current = usePlayerStore.getState().song
      if (current?.id === guitarSplitJob.songId) updateSongDetails({ ...current, guitarSplitStatus: 'failed' })
      setToast(job.status === 'cancelled' ? '吉他分轨已取消，继续使用原吉他轨' : '吉他分轨未完成，已保留原吉他轨')
    }
  }, [guitarSplitJob, tasksQuery.data, updateSongDetails])

  const editSongMetadata = async (): Promise<void> => {
    const selected = actionSong
    if (!selected) return
    try {
      const detail = fixtureMode ? fixtureDetail(selected) : await window.bandbuddy.library.get(selected.id)
      if (!detail) { setToast('歌曲不存在或已被删除'); return }
      setMetadataSong(detail)
      setMetadataOpen(true)
    } catch (error) {
      setToast(toUserErrorMessage(error, '无法读取歌曲信息，请重试'))
    }
  }

  const recordingLocked = !['idle', 'failed'].includes(recordingState.phase)
  useKeyboardShortcuts({ song, practice, selectedStem, seek, togglePlayback, restartPlayback, cycleLoop, patchPractice, patchTrack, setSelectedStem, enabled: view !== 'rehearsal' && view !== 'arsenal' && view !== 'woodshed' && !globallyRecording })

  const tasks = tasksQuery.data ?? []
  const activeTaskCount = tasks.filter((job) => !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status)).length
  const runtime = runtimeQuery.data
  const settings = settingsQuery.data
  const songs = songsQuery.data?.items ?? []
  const currentGuitarSplitTask = song
    ? tasks.find((job) => job.songId === song.id && job.type === 'guitarSplit')
    : undefined
  const guitarSplitPending = Boolean(song && song.guitarSplitStatus !== 'ready' && (
    guitarSplitJob?.songId === song.id
    || (currentGuitarSplitTask
      ? !['completed', 'cancelled', 'failed', 'interrupted'].includes(currentGuitarSplitTask.status)
      : song.guitarSplitStatus === 'pending')
  ))
  const rehearsalInitialId = activeRehearsalId ?? rehearsalReturn?.rehearsalId ?? null
  const restoreRehearsalContext = Boolean(
    rehearsalReturn && rehearsalReturn.rehearsalId === rehearsalInitialId
  )

  const changeView = async (next: 'library' | 'practice' | 'woodshed' | 'rehearsal' | 'arsenal'): Promise<void> => {
    if (next === view) return
    void saveNow().catch(() => undefined)
    if (next === 'library' || next === 'practice' || next === 'arsenal' || next === 'woodshed') setRehearsalReturn(null)
    setView(next)
  }

  const returnFromPractice = async (): Promise<void> => {
    await saveNow()
    if (rehearsalReturn) {
      setActiveRehearsalId(rehearsalReturn.rehearsalId)
      setView('rehearsal')
    } else {
      setView('library')
    }
  }

  return <div className="app-shell">
    <Header
      view={view}
      recording={globallyRecording}
      onView={(next) => void changeView(next)}
      taskCount={activeTaskCount}
      onTasks={() => setTasksOpen(true)}
      onSettings={() => { if (globallyRecording || recordingLocked || rehearsalRecordingLocked) setAppearanceOpen(true); else setSettingsOpen(true) }}
    />
    <Suspense fallback={<main className="page"><p role="status">正在打开…</p></main>}>
    {(visitedRooms.woodshed || view === 'woodshed') && <div className="kept-audio-page" style={{ display: view === 'woodshed' ? 'contents' : 'none' }} aria-hidden={view !== 'woodshed'} inert={view !== 'woodshed'}><WoodshedPage active={view === 'woodshed'} outputDeviceId={settings?.audioOutputDeviceId} onToast={setToast} /></div>}
    {view === 'arsenal' ? <ArsenalPage onToast={setToast} /> : view === 'library' ? <LibraryPage
      songs={songs} loading={songsQuery.isLoading} recentSongs={recentQuery.data?.items ?? []} recentTotal={recentQuery.data?.total ?? 0} recentOffset={recentOffset} onRecentPage={setRecentOffset} total={songsQuery.data?.total ?? 0} offset={offset} pageSize={50} onPage={setOffset} error={songsQuery.error ? toUserErrorMessage(songsQuery.error, '无法读取曲库，请重试') : undefined} onRetry={() => void songsQuery.refetch()} query={query} filter={filter} layout={layout}
      onQuery={(value) => { setQuery(value); setOffset(0) }} onFilter={(value) => { setFilter(value); setOffset(0) }} onLayout={setLayout} onImport={() => setImportOpen(true)}
      onOpen={(selected) => { setRehearsalReturn(null); void openSong(selected) }} onPlay={(selected) => { setRehearsalReturn(null); void openSong(selected, true) }}
      onFavorite={(selected) => void window.bandbuddy.library.update({ id: selected.id, patch: { favorite: !selected.favorite } })}
      onMenu={(selected) => { setActionSong(selected); setSongActionsOpen(true) }}
    /> : view === 'practice' ? (song && practice ? <PracticeRoom
      song={song} practice={practice} playing={playing} selectedStem={selectedStem}
      availableOutputChannelPairs={availableOutputChannelPairs}
      outputLatencyMs={engine.current.outputLatencySeconds * 1000}
      onTogglePlayback={() => void togglePlayback()} onRestart={restartPlayback} onCycleLoop={cycleLoop}
      recordingState={recordingState} locked={globallyRecording}
      guitarSplitPending={fixtureGuitarPreview === 'pending' || guitarSplitPending}
      guitarSplitReady={(fixtureGuitarPreview === 'ready' && !fixtureGuitarReadyDismissed) || guitarSplitReadySongId === song.id}
      onDismissGuitarSplitReady={() => { setFixtureGuitarReadyDismissed(true); setGuitarSplitReadySongId(null) }}
      backLabel={rehearsalReturn ? '返回排练房' : '返回曲库'}
      onBack={() => void returnFromPractice()} onSeek={seek} onPatch={patch => { if (allowAudioAction()) patchPractice(patch) }} onGuitarSplit={(enabled) => void setGuitarSplitMode(enabled)} onTrack={(stem, patch) => { if (allowAudioAction()) patchTrack(stem, patch) }}
      onSelected={setSelectedStem} onExport={() => setExportOpen(true)} onAddRecordingTrack={() => void createRecordingTrack()} onEdit={() => { setMetadataSong(song); setMetadataOpen(true) }}
      onMore={() => { setActionSong(song); setSongActionsOpen(true) }}
      onRecord={(recordingTrackId) => void startRecording(recordingTrackId)} onStopRecording={() => void stopRecording()} onCancelRecording={() => void cancelRecording()}
      onSelectTake={(recordingTrackId, takeId) => void selectTake(recordingTrackId, takeId)} onUpdateTake={(takeId, patch) => void updateTake(takeId, patch)}
      onDeleteTake={(takeId) => void deleteTake(takeId)} onRecordingTrack={(recordingTrackId, patch) => void updateRecordingTrack(recordingTrackId, patch)}
      onUseTakePractice={(rate, pitchSemitones) => patchPractice({ playbackRate: rate, pitchSemitones })}
    /> : <NoSongPractice onLibrary={() => setView('library')} onImport={() => setImportOpen(true)} />) : null}
    {(visitedRooms.rehearsal || view === 'rehearsal') && <div className="kept-audio-page" style={{ display: view === 'rehearsal' ? 'contents' : 'none' }} aria-hidden={view !== 'rehearsal'} inert={view !== 'rehearsal'}><RehearsalRoom active={view === 'rehearsal'}
      settings={settings}
      initialRehearsalId={rehearsalInitialId}
      initialItemId={restoreRehearsalContext ? rehearsalReturn?.itemId : null}
      initialScrollTop={restoreRehearsalContext ? rehearsalReturn?.scrollTop : 0}
      onActiveChange={setActiveRehearsalId}
      onOpenSongSettings={({ rehearsalId, itemId, songId, scrollTop }) => {
        setRehearsalReturn({ rehearsalId, itemId, scrollTop })
        void openSong(songId)
      }}
      onRecordingLockChange={setRehearsalRecordingLocked}
      onToast={setToast}
    /></div>}
    </Suspense>
    {view !== 'rehearsal' && view !== 'arsenal' && view !== 'woodshed' && <PlayerBar practiceMode={view === 'practice'} countInRemaining={countInRemaining} locked={globallyRecording} onToggle={() => void togglePlayback()} onSeek={seek} onRestart={restartPlayback} onCycleLoop={cycleLoop} onPractice={() => {
      if (!song) return
      setRehearsalReturn(null)
      setView('practice')
    }} />}

    <BackgroundRecording view={view} onReturn={owner => void changeView(owner)} />
    <BackgroundTransport view={view} onReturn={owner => void changeView(owner)} />
    <Suspense fallback={null}>
    {importOpen && <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(songId) => { setTasksOpen(true); void client.invalidateQueries({ queryKey: ['songs'] }); setToast(`歌曲已加入曲库 · ${songId.slice(0, 8)}`) }} onOpenDuplicate={(songId) => void openSong(songId)} onNeedsRuntime={() => { if (runtime?.status !== 'ready') setTasksOpen(true) }} />}
    {tasksOpen && <TasksDrawer open={tasksOpen} onOpenChange={setTasksOpen} jobs={tasks} runtime={runtime} onRefresh={() => void tasksQuery.refetch()} />}
    {appearanceOpen && <AppearanceDialog open={appearanceOpen} onOpenChange={setAppearanceOpen} />}
    {settingsOpen && runtime && settings && <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} runtime={runtime} settings={settings} onSaved={(saved: AppSettings) => {
      client.setQueryData(['settings'], saved)
      void engine.current.setOutputDevice(saved.audioOutputDeviceId)
        .then(() => setAvailableOutputChannelPairs(fixtureMode ? 6 : engine.current.availableOutputChannelPairs))
        .catch(() => setToast('无法切换到所选音频输出，请检查设备连接或权限'))
    }} onRefresh={() => { void runtimeQuery.refetch(); void tasksQuery.refetch() }} />}
    {exportOpen && song && practice && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} song={song} practice={practice} onBeforeStart={saveNow} />}
    {metadataOpen && metadataSong && <MetadataDialog open={metadataOpen} onOpenChange={(open) => { setMetadataOpen(open); if (!open) setMetadataSong(null) }} song={metadataSong} onSaved={(updated) => { if (song?.id === updated.id) void replaceCurrentSong(updated); setMetadataSong(updated); void client.invalidateQueries({ queryKey: ['songs'] }) }} />}
    {songActionsOpen && <SongActionsDialog open={songActionsOpen} onOpenChange={setSongActionsOpen} song={actionSong}
      onOpen={() => { if (actionSong) void openSong(actionSong) }}
      onEditMetadata={() => void editSongMetadata()}
      onImportLyrics={() => void importLyrics()}
      onReveal={() => { if (actionSong) void window.bandbuddy.library.openLocation(actionSong.id) }}
      onReseparate={() => { if (!actionSong) return; void window.bandbuddy.library.reSeparate(actionSong.id).then(() => { setTasksOpen(true); if (runtime?.status !== 'ready') setSettingsOpen(true) }).catch((error) => setToast(toUserErrorMessage(error, '无法重新分轨，请重试'))) }}
      onDelete={() => { if (!actionSong || !allowAudioAction()) return; const deleting = actionSong; if (song?.id === deleting.id) { engine.current.unload(); unloadSong(); setView('library') } void window.bandbuddy.library.delete(deleting.id).then(() => { setActionSong(null); void client.invalidateQueries({ queryKey: ['songs'] }) }).catch((error) => setToast(toUserErrorMessage(error, '删除失败，请重试'))) }} />}
    </Suspense>
    {toast && <button className="toast" onClick={() => setToast('')}><AlertTriangle size={16} />{toast}<span>×</span></button>}
  </div>
}

function NoSongPractice({ onLibrary, onImport }: { onLibrary(): void; onImport(): void }): React.JSX.Element {
  return <main className="page no-song-practice"><span><Library size={38} /></span><h1>还没有正在练习的歌曲</h1><p>从曲库选择一首已完成分轨的歌曲，或先导入新歌曲。</p><div><button className="outline-button" onClick={onLibrary}>返回曲库</button><button className="primary-button" onClick={onImport}><Plus size={18} />导入歌曲</button></div></main>
}

function useKeyboardShortcuts({
  song, practice, selectedStem, seek, togglePlayback, restartPlayback, cycleLoop, patchPractice, patchTrack, setSelectedStem, enabled
}: {
  song: SongDetail | null
  practice: PracticeState | null
  selectedStem: StemType
  seek(milliseconds: number): void
  togglePlayback(): Promise<void>
  restartPlayback(): void
  cycleLoop(): void
  patchPractice(patch: Partial<PracticeState>): void
  patchTrack(stem: StemType, patch: Partial<PracticeState['tracks'][number]>): void
  setSelectedStem(stem: StemType): void
  enabled: boolean
}): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!enabled || !song || !practice || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.matches('input, textarea, select, [contenteditable="true"]') || target?.closest('[data-dialog-open="true"], [role="menu"], [role="combobox"], [role="listbox"]')) return
      const currentMs = usePlayerStore.getState().currentMs
      const selected = practice.tracks.find((track) => track.stemType === selectedStem)
      const stemOrder = normalizeTrackOrder(practice.trackOrder, song.recordingTracks.map((track) => track.id))
        .map(getStemTypeFromTrackOrderKey)
        .filter((stemType): stemType is StemType => stemType !== null && (song.sourceFormat === 'existing-stems' ? song.stems.some((stem) => stem.type === stemType) : isStemVisible(stemType, practice.guitarSplitEnabled)))
      const index = stemOrder.indexOf(selectedStem)
      if (event.code === 'Space') { event.preventDefault(); void togglePlayback() }
      else if (event.key === 'Home') { event.preventDefault(); restartPlayback() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(currentMs - (event.shiftKey ? 1000 : 5000)) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(currentMs + (event.shiftKey ? 1000 : 5000)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedStem(stemOrder[Math.max(0, index - 1)] ?? selectedStem) }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedStem(stemOrder[Math.min(stemOrder.length - 1, index + 1)] ?? selectedStem) }
      else if (event.key.toLowerCase() === 'a' && !event.repeat) patchPractice({ loopStartMs: currentMs, loopEndMs: null, loopEnabled: false })
      else if (event.key.toLowerCase() === 'b' && practice.loopStartMs !== null && !practice.loopEnabled && !event.repeat) cycleLoop()
      else if (event.key.toLowerCase() === 'l' && !event.repeat) cycleLoop()
      else if (event.key.toLowerCase() === 'm' && selected) patchTrack(selectedStem, silenceToggle(selected))
      else if (event.key.toLowerCase() === 's' && selected) patchTrack(selectedStem, { solo: !selected.solo })
      else if ((event.key === '+' || event.key === '=') && selected) patchTrack(selectedStem, { gainDb: clamp(selected.gainDb + 1, -60, 6) })
      else if (event.key === '-' && selected) patchTrack(selectedStem, { gainDb: clamp(selected.gainDb - 1, -60, 6) })
      else if (event.key === '0' && selected) patchTrack(selectedStem, { gainDb: 0 })
      else if (event.key === 'Escape' && !document.fullscreenElement) patchPractice({ loopStartMs: null, loopEndMs: null, loopEnabled: false })
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [song, practice, selectedStem, seek, togglePlayback, restartPlayback, cycleLoop, patchPractice, patchTrack, setSelectedStem, enabled])
}
