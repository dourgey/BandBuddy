import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Library, Plus } from 'lucide-react'
import {
  GUITAR_SPLIT_STEMS,
  getStemTypeFromTrackOrderKey,
  isStemVisible,
  normalizeSelectedStemForGuitarMode,
  normalizeTrackOrder,
  type AppSettings,
  type DesktopLyricsPayload,
  type PracticeState,
  type RecordingMeter,
  type RecordingState,
  type RecordingTrackState,
  type SongDetail,
  type SongSummary,
  type StemType
} from '@shared/domain.js'
import { lyricFrameAt } from '@shared/lyrics.js'
import { nextLoopState, restartPositionMs } from '@shared/playback.js'
import { MultiTrackAudioEngine } from './audio-engine.js'
import { ExportDialog, ImportDialog, MetadataDialog, SettingsDrawer, SongActionsDialog, TasksDrawer } from './components/Dialogs.js'
import { Header } from './components/Header.js'
import { PlayerBar } from './components/PlayerBar.js'
import { fixtureDetail, fixtureSongs } from './fixtures.js'
import { usePlayerStore } from './player-store.js'
import { LibraryPage } from './pages/LibraryPage.js'
import { PracticeRoom } from './pages/PracticeRoom.js'
import { RehearsalRoom } from './pages/RehearsalRoom.js'
import { ArsenalPage } from './pages/ArsenalPage.js'
import { loadStartupAudioSettings } from './startup-audio-devices.js'
import { clamp, isCancellationError, silenceToggle, toUserErrorMessage } from './utils.js'
import './playback-media.css'

const previewParams = new URLSearchParams(location.search)
const fixtureMode = import.meta.env.DEV && previewParams.has('fixtures')
const fixtureGuitarPreview = import.meta.env.DEV ? previewParams.get('guitarSplit') : null

export default function App(): React.JSX.Element {
  const client = useQueryClient()
  const engine = useRef<MultiTrackAudioEngine>(new MultiTrackAudioEngine())
  const [view, setView] = useState<'library' | 'practice' | 'rehearsal' | 'arsenal'>('library')
  const [activeRehearsalId, setActiveRehearsalId] = useState<string | null>(null)
  const [rehearsalReturn, setRehearsalReturn] = useState<{
    rehearsalId: string
    itemId: string
    scrollTop: number
  } | null>(null)
  const [rehearsalRecordingLocked, setRehearsalRecordingLocked] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'favorite' | 'processing' | 'recent'>('all')
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [importOpen, setImportOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const [recordingMeter, setRecordingMeter] = useState<RecordingMeter>({
    peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: 0, recording: false
  })
  const recordingWasActive = useRef(false)
  const viewRef = useRef(view)

  const song = usePlayerStore((state) => state.song)
  const practice = usePlayerStore((state) => state.practice)
  const currentMs = usePlayerStore((state) => state.currentMs)
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
  const desktopLyricsVisible = view === 'practice'
    && Boolean(song?.lyrics?.cues.length && practice?.desktopLyricsEnabled)
  const lastDesktopLyricsUpdate = useRef({ at: 0, signature: '' })

  useEffect(() => { viewRef.current = view }, [view])

  const songsQuery = useQuery({
    queryKey: ['songs', query, filter, fixtureMode],
    queryFn: async () => {
      const source = fixtureMode ? fixtureSongs : await window.bandbuddy.library.list({ query, filter })
      const normalized = query.trim().toLocaleLowerCase()
      return source.filter((item) => !normalized || `${item.title} ${item.artist}`.toLocaleLowerCase().includes(normalized)).filter((item) => {
        if (!fixtureMode) return true
        if (filter === 'favorite') return item.favorite
        if (filter === 'processing') return item.status !== 'ready'
        if (filter === 'recent') return item.lastPracticedAt !== null
        return true
      })
    }
  })
  const tasksQuery = useQuery({ queryKey: ['tasks'], queryFn: () => window.bandbuddy.tasks.list() })
  const runtimeQuery = useQuery({ queryKey: ['runtime'], queryFn: () => window.bandbuddy.runtime.get() })
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fixtureMode ? () => window.bandbuddy.settings.get() : loadStartupAudioSettings,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  useEffect(() => {
    void window.bandbuddy.recording.state().then(setRecordingState)
    const unsubscribe = [
      window.bandbuddy.library.onChanged(() => void client.invalidateQueries({ queryKey: ['songs'] })),
      window.bandbuddy.tasks.onChanged(() => void client.invalidateQueries({ queryKey: ['tasks'] })),
      window.bandbuddy.runtime.onChanged((value) => client.setQueryData(['runtime'], value)),
      window.bandbuddy.settings.onChanged((value) => client.setQueryData(['settings'], value)),
      window.bandbuddy.recording.onState((value) => {
        setRecordingState(value)
        setCountInRemaining(value.countInRemaining)
        if (['countIn', 'armed', 'recording', 'stopping'].includes(value.phase)) setCurrentMs(value.sourcePositionMs)
        if (value.error && !isCancellationError(value.error)) {
          setToast(toUserErrorMessage(value.error, '录音失败，请检查声卡后重试'))
        }
      }),
      window.bandbuddy.recording.onMeter(setRecordingMeter)
    ]
    return () => unsubscribe.forEach((stop) => stop())
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
    engine.current.onEnded(() => { setPlaying(false); setCountInRemaining(0); setCurrentMs(0) })
    engine.current.onError(() => {
      patchPractice({ pitchSemitones: 0 })
      setToast('实时升降调初始化失败，已恢复原调；请重试或检查音频组件')
    })
    return () => engine.current.destroy()
  }, [patchPractice, setCurrentMs, setPlaying])

  useEffect(() => {
    if (practice) engine.current.applyPractice(practice)
  }, [practice])

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
    if (view === 'rehearsal') return
    void window.bandbuddy.desktopLyrics.setVisible(desktopLyricsVisible).catch(() => {
      if (!desktopLyricsVisible) return
      patchPractice({ desktopLyricsEnabled: false })
      setToast('无法打开桌面歌词，请重启应用后重试')
    })
  }, [desktopLyricsVisible, patchPractice, view])

  useEffect(() => () => {
    void window.bandbuddy.desktopLyrics.setVisible(false)
  }, [])

  useEffect(() => {
    if (!desktopLyricsVisible || !song?.lyrics) return
    const frame = lyricFrameAt(song.lyrics.cues, currentMs)
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
  }, [currentMs, desktopLyricsVisible, playing, song])

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
    if (!['idle', 'failed'].includes(recordingState.phase)) await stopRecording()
    const summary = typeof summaryOrId === 'string' ? fixtureSongs.find((item) => item.id === summaryOrId) : summaryOrId
    const detail = fixtureMode && summary ? fixtureDetail(summary) : await window.bandbuddy.library.get(typeof summaryOrId === 'string' ? summaryOrId : summaryOrId.id)
    if (!detail) { setToast('歌曲不存在或已被删除'); return }
    engine.current.pause()
    setCountInRemaining(0)
    loadSong(detail)
    setView('practice')
    try {
      await engine.current.load(detail, settingsQuery.data?.audioOutputDeviceId, settingsQuery.data?.latencyMode)
      setAvailableOutputChannelPairs(fixtureMode ? 6 : engine.current.availableOutputChannelPairs)
    } catch {
      setToast('无法加载音频，请检查音频文件或输出设备')
      return
    }
    const loadedPractice = usePlayerStore.getState().practice
    if (loadedPractice) engine.current.applyPractice(loadedPractice, true)
    if (autoPlay) {
      try {
        const started = await engine.current.play(loadedPractice?.countInBeats ?? 0, setCountInRemaining)
        setPlaying(started)
      } catch {
        setCountInRemaining(0)
        setPlaying(false)
        setToast('音频暂时无法播放，请检查文件是否完整')
      }
    }
  }

  const togglePlayback = async (): Promise<void> => {
    if (!song || !['idle', 'failed'].includes(recordingState.phase)) return
    if (playing || countInRemaining > 0) {
      engine.current.pause()
      setCountInRemaining(0)
      setPlaying(false)
      patchPractice({ positionMs: currentMs })
      await saveNow()
    }
    else {
      try {
        const countIn = practice?.countInBeats ?? 0
        if (countIn > 0) setCountInRemaining(countIn)
        const started = await engine.current.play(countIn, setCountInRemaining)
        setPlaying(started)
      } catch {
        setCountInRemaining(0)
        setPlaying(false)
        setToast('播放失败，请检查音频文件或输出设备')
      }
    }
  }

  const seek = (milliseconds: number): void => {
    if (!song || !['idle', 'failed'].includes(recordingState.phase)) return
    const position = clamp(milliseconds, 0, song.durationMs)
    engine.current.seek(position)
    setCurrentMs(position)
    patchPractice({ positionMs: position })
  }

  const playFrom = async (milliseconds: number): Promise<void> => {
    const state = usePlayerStore.getState()
    if (!state.song || !state.practice || !['idle', 'failed'].includes(recordingState.phase)) return
    engine.current.pause()
    setCountInRemaining(0)
    setPlaying(false)
    seek(milliseconds)
    // Apply a newly completed A-B range before restarting; the React effect
    // may not have committed yet when this handler is invoked.
    engine.current.applyPractice(usePlayerStore.getState().practice!)
    try {
      const started = await engine.current.play()
      if (started && usePlayerStore.getState().song?.id === state.song.id) setPlaying(true)
    } catch {
      setToast('播放失败，请检查音频文件或输出设备')
    }
  }

  const restartPlayback = (): void => {
    const state = usePlayerStore.getState()
    if (state.practice) void playFrom(restartPositionMs(state.practice))
  }

  const cycleLoop = (): void => {
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
    const wasPlaying = playing
    engine.current.pause()
    const nextSong = {
      ...updated,
      practice: preserveLocalPractice ? practice ?? updated.practice : updated.practice
    }
    loadSong(nextSong)
    try {
      await engine.current.load(nextSong, settingsQuery.data?.audioOutputDeviceId, settingsQuery.data?.latencyMode)
      setAvailableOutputChannelPairs(fixtureMode ? 6 : engine.current.availableOutputChannelPairs)
    } catch {
      setToast('无法加载音频，请检查音频文件或输出设备')
      return
    }
    if (wasPlaying) { await engine.current.play(); setPlaying(true) }
  }

  const refreshCurrentSong = async (): Promise<void> => {
    const current = usePlayerStore.getState().song
    if (!current || fixtureMode) return
    const updated = await window.bandbuddy.library.get(current.id)
    if (updated) await replaceCurrentSong(updated)
  }

  const startRecording = async (recordingTrackId: string): Promise<void> => {
    const state = usePlayerStore.getState()
    if (!state.song || !state.practice || fixtureMode) return
    engine.current.pause()
    setPlaying(false)
    setCountInRemaining(0)
    setRecordingMeter({ peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: state.currentMs, recording: false })
    try {
      await saveNow()
      await window.bandbuddy.recording.start({
        songId: state.song.id,
        recordingTrackId,
        positionMs: state.currentMs,
        practice: state.practice
      })
    } catch (error) {
      if (!isCancellationError(error)) setToast(toUserErrorMessage(error, '录音失败，请检查声卡后重试'))
    }
  }

  const stopRecording = async (): Promise<void> => {
    if (fixtureMode) return
    try {
      await window.bandbuddy.recording.stop()
      await refreshCurrentSong()
    } catch (error) {
      setToast(toUserErrorMessage(error, '停止录音失败，请重试'))
    }
  }

  const cancelRecording = async (): Promise<void> => {
    if (fixtureMode) return
    await window.bandbuddy.recording.cancel()
    setRecordingMeter({ peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: currentMs, recording: false })
  }

  const createRecordingTrack = async (): Promise<void> => {
    if (!song || fixtureMode) return
    try {
      await window.bandbuddy.recording.createTrack(song.id)
      await refreshCurrentSong()
    } catch (error) {
      setToast(toUserErrorMessage(error, '无法创建录音轨，请重试'))
    }
  }

  const selectTake = async (recordingTrackId: string, takeId: string | null): Promise<void> => {
    if (fixtureMode) return
    await window.bandbuddy.recording.selectTake({ recordingTrackId, takeId })
    await refreshCurrentSong()
  }

  const updateTake = async (takeId: string, patch: { name?: string; alignmentOffsetMs?: number }): Promise<void> => {
    if (fixtureMode) return
    await window.bandbuddy.recording.updateTake({ takeId, ...patch })
    await refreshCurrentSong()
  }

  const deleteTake = async (takeId: string): Promise<void> => {
    if (fixtureMode || !window.confirm('确定删除这个 Take？此操作无法撤销。')) return
    await window.bandbuddy.recording.deleteTake(takeId)
    await refreshCurrentSong()
  }

  const updateRecordingTrack = async (
    recordingTrackId: string,
    patch: Partial<Pick<RecordingTrackState, 'name' | 'gainDb' | 'muted' | 'solo'>>
  ): Promise<void> => {
    if (fixtureMode) return
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
    if (!window.confirm('这首歌需要重新分轨才能生成木吉他、Lead 和 Rhythm。完成前会继续使用当前分轨，是否继续？')) return
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
  useKeyboardShortcuts({ song, practice, currentMs, selectedStem, seek, togglePlayback, restartPlayback, cycleLoop, patchPractice, patchTrack, setSelectedStem, enabled: view !== 'rehearsal' && !recordingLocked })

  const tasks = tasksQuery.data ?? []
  const activeTaskCount = tasks.filter((job) => !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status)).length
  const runtime = runtimeQuery.data
  const settings = settingsQuery.data
  const songs = songsQuery.data ?? []
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

  const changeView = async (next: 'library' | 'practice' | 'rehearsal' | 'arsenal'): Promise<void> => {
    if (rehearsalRecordingLocked || next === view) return
    if (view === 'practice') {
      if (recordingLocked) await stopRecording()
      engine.current.pause()
      setPlaying(false)
      setCountInRemaining(0)
      await saveNow()
    }
    if (next === 'library' || next === 'practice' || next === 'arsenal') setRehearsalReturn(null)
    setView(next)
  }

  const returnFromPractice = async (): Promise<void> => {
    if (recordingLocked) await stopRecording()
    engine.current.pause()
    setPlaying(false)
    setCountInRemaining(0)
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
      locked={rehearsalRecordingLocked}
      onView={(next) => void changeView(next)}
      taskCount={activeTaskCount}
      onTasks={() => setTasksOpen(true)}
      onSettings={() => setSettingsOpen(true)}
    />
    {view === 'arsenal' ? <ArsenalPage onToast={setToast} /> : view === 'library' ? <LibraryPage
      songs={songs} loading={songsQuery.isLoading} query={query} filter={filter} layout={layout}
      onQuery={setQuery} onFilter={setFilter} onLayout={setLayout} onImport={() => setImportOpen(true)}
      onOpen={(selected) => { setRehearsalReturn(null); void openSong(selected) }} onPlay={(selected) => { setRehearsalReturn(null); void openSong(selected, true) }}
      onFavorite={(selected) => void window.bandbuddy.library.update({ id: selected.id, patch: { favorite: !selected.favorite } })}
      onMenu={(selected) => { setActionSong(selected); setSongActionsOpen(true) }}
    /> : view === 'rehearsal' ? <RehearsalRoom
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
    /> : song && practice ? <PracticeRoom
      song={song} practice={practice} currentMs={currentMs} playing={playing} selectedStem={selectedStem}
      availableOutputChannelPairs={availableOutputChannelPairs}
      outputLatencyMs={engine.current.outputLatencySeconds * 1000}
      onTogglePlayback={() => void togglePlayback()} onRestart={restartPlayback} onCycleLoop={cycleLoop}
      recordingState={recordingState} recordingMeter={recordingMeter} locked={recordingLocked}
      guitarSplitPending={fixtureGuitarPreview === 'pending' || guitarSplitPending}
      guitarSplitReady={(fixtureGuitarPreview === 'ready' && !fixtureGuitarReadyDismissed) || guitarSplitReadySongId === song.id}
      onDismissGuitarSplitReady={() => { setFixtureGuitarReadyDismissed(true); setGuitarSplitReadySongId(null) }}
      backLabel={rehearsalReturn ? '返回排练房' : '返回曲库'}
      onBack={() => void returnFromPractice()} onSeek={seek} onPatch={patchPractice} onGuitarSplit={(enabled) => void setGuitarSplitMode(enabled)} onTrack={patchTrack}
      onSelected={setSelectedStem} onExport={() => setExportOpen(true)} onAddRecordingTrack={() => void createRecordingTrack()} onEdit={() => { setMetadataSong(song); setMetadataOpen(true) }}
      onMore={() => { setActionSong(song); setSongActionsOpen(true) }}
      onRecord={(recordingTrackId) => void startRecording(recordingTrackId)} onStopRecording={() => void stopRecording()} onCancelRecording={() => void cancelRecording()}
      onSelectTake={(recordingTrackId, takeId) => void selectTake(recordingTrackId, takeId)} onUpdateTake={(takeId, patch) => void updateTake(takeId, patch)}
      onDeleteTake={(takeId) => void deleteTake(takeId)} onRecordingTrack={(recordingTrackId, patch) => void updateRecordingTrack(recordingTrackId, patch)}
      onUseTakePractice={(rate, pitchSemitones) => patchPractice({ playbackRate: rate, pitchSemitones })}
    /> : <NoSongPractice onLibrary={() => setView('library')} onImport={() => setImportOpen(true)} />}
    {view !== 'rehearsal' && <PlayerBar practiceMode={view === 'practice'} countInRemaining={countInRemaining} locked={recordingLocked} onToggle={() => void togglePlayback()} onSeek={seek} onRestart={restartPlayback} onCycleLoop={cycleLoop} onPractice={() => {
      if (!song) return
      setRehearsalReturn(null)
      setView('practice')
    }} />}

    <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(songId) => { setTasksOpen(true); void client.invalidateQueries({ queryKey: ['songs'] }); setToast(`歌曲已加入曲库 · ${songId.slice(0, 8)}`) }} onOpenDuplicate={(songId) => void openSong(songId)} onNeedsRuntime={() => { if (runtime?.status !== 'ready') setSettingsOpen(true) }} />
    <TasksDrawer open={tasksOpen} onOpenChange={setTasksOpen} jobs={tasks} onRefresh={() => void tasksQuery.refetch()} />
    {runtime && settings && <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} runtime={runtime} settings={settings} onSaved={(saved: AppSettings) => {
      client.setQueryData(['settings'], saved)
      void engine.current.setOutputDevice(saved.audioOutputDeviceId)
        .then(() => setAvailableOutputChannelPairs(fixtureMode ? 6 : engine.current.availableOutputChannelPairs))
        .catch(() => setToast('无法切换到所选音频输出，请检查设备连接或权限'))
    }} onRefresh={() => { void runtimeQuery.refetch(); void tasksQuery.refetch() }} />}
    {song && practice && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} song={song} practice={practice} onBeforeStart={saveNow} />}
    {metadataSong && <MetadataDialog open={metadataOpen} onOpenChange={(open) => { setMetadataOpen(open); if (!open) setMetadataSong(null) }} song={metadataSong} onSaved={(updated) => { if (song?.id === updated.id) void replaceCurrentSong(updated); setMetadataSong(updated); void client.invalidateQueries({ queryKey: ['songs'] }) }} />}
    <SongActionsDialog open={songActionsOpen} onOpenChange={setSongActionsOpen} song={actionSong}
      onOpen={() => { if (actionSong) void openSong(actionSong) }}
      onEditMetadata={() => void editSongMetadata()}
      onImportLyrics={() => void importLyrics()}
      onReveal={() => { if (actionSong) void window.bandbuddy.library.openLocation(actionSong.id) }}
      onReseparate={() => { if (!actionSong) return; void window.bandbuddy.library.reSeparate(actionSong.id).then(() => { setTasksOpen(true); if (runtime?.status !== 'ready') setSettingsOpen(true) }).catch((error) => setToast(toUserErrorMessage(error, '无法重新分轨，请重试'))) }}
      onDelete={() => { if (!actionSong) return; const deleting = actionSong; if (song?.id === deleting.id) { engine.current.unload(); unloadSong(); setView('library') } void window.bandbuddy.library.delete(deleting.id).then(() => { setActionSong(null); void client.invalidateQueries({ queryKey: ['songs'] }) }).catch((error) => setToast(toUserErrorMessage(error, '删除失败，请重试'))) }} />
    {toast && <button className="toast" onClick={() => setToast('')}><AlertTriangle size={16} />{toast}<span>×</span></button>}
  </div>
}

function NoSongPractice({ onLibrary, onImport }: { onLibrary(): void; onImport(): void }): React.JSX.Element {
  return <main className="page no-song-practice"><span><Library size={38} /></span><h1>还没有正在练习的歌曲</h1><p>从曲库选择一首已完成分轨的歌曲，或先导入新歌曲。</p><div><button className="outline-button" onClick={onLibrary}>返回曲库</button><button className="primary-button" onClick={onImport}><Plus size={18} />导入歌曲</button></div></main>
}

function useKeyboardShortcuts({
  song, practice, currentMs, selectedStem, seek, togglePlayback, restartPlayback, cycleLoop, patchPractice, patchTrack, setSelectedStem, enabled
}: {
  song: SongDetail | null
  practice: PracticeState | null
  currentMs: number
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
  }, [song, practice, currentMs, selectedStem, seek, togglePlayback, restartPlayback, cycleLoop, patchPractice, patchTrack, setSelectedStem, enabled])
}
