import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Library, Plus } from 'lucide-react'
import { STEM_ORDER, type AppSettings, type PracticeState, type SongDetail, type SongSummary, type StemType } from '@shared/domain.js'
import { MultiTrackAudioEngine } from './audio-engine.js'
import { ExportDialog, ImportDialog, MetadataDialog, SettingsDrawer, SongActionsDialog, TasksDrawer } from './components/Dialogs.js'
import { Header } from './components/Header.js'
import { PlayerBar } from './components/PlayerBar.js'
import { fixtureDetail, fixtureSongs } from './fixtures.js'
import { usePlayerStore } from './player-store.js'
import { LibraryPage } from './pages/LibraryPage.js'
import { PracticeRoom } from './pages/PracticeRoom.js'
import { clamp } from './utils.js'

const fixtureMode = import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')

export default function App(): React.JSX.Element {
  const client = useQueryClient()
  const engine = useRef<MultiTrackAudioEngine>(new MultiTrackAudioEngine())
  const [view, setView] = useState<'library' | 'practice'>('library')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'favorite' | 'processing' | 'recent'>('all')
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [importOpen, setImportOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [songActionsOpen, setSongActionsOpen] = useState(false)
  const [actionSong, setActionSong] = useState<SongSummary | null>(null)
  const [toast, setToast] = useState('')
  const [countInRemaining, setCountInRemaining] = useState(0)

  const song = usePlayerStore((state) => state.song)
  const practice = usePlayerStore((state) => state.practice)
  const currentMs = usePlayerStore((state) => state.currentMs)
  const playing = usePlayerStore((state) => state.playing)
  const selectedStem = usePlayerStore((state) => state.selectedStem)
  const loadSong = usePlayerStore((state) => state.loadSong)
  const unloadSong = usePlayerStore((state) => state.unload)
  const setPlaying = usePlayerStore((state) => state.setPlaying)
  const setCurrentMs = usePlayerStore((state) => state.setCurrentMs)
  const patchPractice = usePlayerStore((state) => state.patchPractice)
  const patchTrack = usePlayerStore((state) => state.patchTrack)
  const setSelectedStem = usePlayerStore((state) => state.setSelectedStem)

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
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => window.bandbuddy.settings.get() })

  useEffect(() => {
    const unsubscribe = [
      window.bandbuddy.library.onChanged(() => void client.invalidateQueries({ queryKey: ['songs'] })),
      window.bandbuddy.tasks.onChanged(() => void client.invalidateQueries({ queryKey: ['tasks'] })),
      window.bandbuddy.runtime.onChanged((value) => client.setQueryData(['runtime'], value)),
      window.bandbuddy.settings.onChanged((value) => client.setQueryData(['settings'], value))
    ]
    return () => unsubscribe.forEach((stop) => stop())
  }, [client])

  useEffect(() => {
    engine.current.onTime(setCurrentMs)
    engine.current.onEnded(() => { setPlaying(false); setCountInRemaining(0); setCurrentMs(0) })
    return () => engine.current.destroy()
  }, [setCurrentMs, setPlaying])

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

  const openSong = async (summaryOrId: SongSummary | string, autoPlay = false): Promise<void> => {
    const summary = typeof summaryOrId === 'string' ? fixtureSongs.find((item) => item.id === summaryOrId) : summaryOrId
    const detail = fixtureMode && summary ? fixtureDetail(summary) : await window.bandbuddy.library.get(typeof summaryOrId === 'string' ? summaryOrId : summaryOrId.id)
    if (!detail) { setToast('歌曲不存在或已被删除'); return }
    engine.current.pause()
    setCountInRemaining(0)
    loadSong(detail)
    setView('practice')
    await engine.current.load(detail, settingsQuery.data?.audioOutputDeviceId, settingsQuery.data?.latencyMode)
    const loadedPractice = usePlayerStore.getState().practice
    if (loadedPractice) engine.current.applyPractice(loadedPractice, true)
    if (autoPlay) {
      try {
        const started = await engine.current.play(loadedPractice?.metronomeEnabled ? loadedPractice.countInBeats : 0, setCountInRemaining)
        setPlaying(started)
      } catch {
        setCountInRemaining(0)
        setPlaying(false)
        setToast('音频暂时无法播放，请检查文件是否完整')
      }
    }
  }

  const togglePlayback = async (): Promise<void> => {
    if (!song) return
    if (playing || countInRemaining > 0) {
      engine.current.pause()
      setCountInRemaining(0)
      setPlaying(false)
      patchPractice({ positionMs: currentMs })
      await saveNow()
    }
    else {
      try {
        const countIn = practice?.metronomeEnabled ? practice.countInBeats : 0
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
    if (!song) return
    const position = clamp(milliseconds, 0, song.durationMs)
    engine.current.seek(position)
    setCurrentMs(position)
    patchPractice({ positionMs: position })
  }

  const replaceCurrentSong = async (updated: SongDetail): Promise<void> => {
    const wasPlaying = playing
    engine.current.pause()
    loadSong({ ...updated, practice: practice ?? updated.practice })
    await engine.current.load({ ...updated, practice: practice ?? updated.practice }, settingsQuery.data?.audioOutputDeviceId, settingsQuery.data?.latencyMode)
    if (wasPlaying) { await engine.current.play(); setPlaying(true) }
  }

  useKeyboardShortcuts({ song, practice, currentMs, selectedStem, seek, togglePlayback, patchPractice, patchTrack, setSelectedStem })

  const tasks = tasksQuery.data ?? []
  const activeTaskCount = tasks.filter((job) => !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status)).length
  const runtime = runtimeQuery.data
  const settings = settingsQuery.data
  const songs = songsQuery.data ?? []

  return <div className="app-shell">
    <Header view={view} onView={(next) => { if (next === 'library') void saveNow(); setView(next) }} taskCount={activeTaskCount} onTasks={() => setTasksOpen(true)} onSettings={() => setSettingsOpen(true)} />
    {view === 'library' ? <LibraryPage
      songs={songs} loading={songsQuery.isLoading} query={query} filter={filter} layout={layout}
      onQuery={setQuery} onFilter={setFilter} onLayout={setLayout} onImport={() => setImportOpen(true)}
      onOpen={(selected) => void openSong(selected)} onPlay={(selected) => void openSong(selected, true)}
      onFavorite={(selected) => void window.bandbuddy.library.update({ id: selected.id, patch: { favorite: !selected.favorite } })}
      onMenu={(selected) => { setActionSong(selected); setSongActionsOpen(true) }}
    /> : song && practice ? <PracticeRoom
      song={song} practice={practice} currentMs={currentMs} playing={playing} selectedStem={selectedStem}
      onBack={() => { void saveNow(); setView('library') }} onSeek={seek} onPatch={patchPractice} onTrack={patchTrack}
      onSelected={setSelectedStem} onExport={() => setExportOpen(true)} onEdit={() => setMetadataOpen(true)}
      onMore={() => { setActionSong(song); setSongActionsOpen(true) }}
    /> : <NoSongPractice onLibrary={() => setView('library')} onImport={() => setImportOpen(true)} />}
    <PlayerBar practiceMode={view === 'practice'} countInRemaining={countInRemaining} onToggle={() => void togglePlayback()} onSeek={seek} onPractice={() => song && setView('practice')} />

    <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={(songId, warnings) => { setTasksOpen(true); void client.invalidateQueries({ queryKey: ['songs'] }); setToast(warnings[0] ?? `歌曲已加入曲库 · ${songId.slice(0, 8)}`) }} onOpenDuplicate={(songId) => void openSong(songId)} onNeedsRuntime={() => { if (runtime?.status !== 'ready') setSettingsOpen(true) }} />
    <TasksDrawer open={tasksOpen} onOpenChange={setTasksOpen} jobs={tasks} onRefresh={() => void tasksQuery.refetch()} />
    {runtime && settings && <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} runtime={runtime} settings={settings} onSaved={(saved: AppSettings) => { client.setQueryData(['settings'], saved); void engine.current.setOutputDevice(saved.audioOutputDeviceId) }} onRefresh={() => { void runtimeQuery.refetch(); void tasksQuery.refetch() }} />}
    {song && practice && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} song={song} practice={practice} onBeforeStart={saveNow} />}
    {song && <MetadataDialog open={metadataOpen} onOpenChange={setMetadataOpen} song={song} onSaved={(updated) => { void replaceCurrentSong(updated); void client.invalidateQueries({ queryKey: ['songs'] }) }} />}
    <SongActionsDialog open={songActionsOpen} onOpenChange={setSongActionsOpen} song={actionSong}
      onOpen={() => { if (actionSong) void openSong(actionSong) }}
      onReveal={() => { if (actionSong) void window.bandbuddy.library.openLocation(actionSong.id) }}
      onReseparate={() => { if (!actionSong) return; void window.bandbuddy.library.reSeparate(actionSong.id).then(() => { setTasksOpen(true); if (runtime?.status !== 'ready') setSettingsOpen(true) }).catch((error) => setToast(String(error).replace(/^Error:\s*/, ''))) }}
      onDelete={() => { if (!actionSong) return; const deleting = actionSong; if (song?.id === deleting.id) { engine.current.unload(); unloadSong(); setView('library') } void window.bandbuddy.library.delete(deleting.id).then(() => { setActionSong(null); void client.invalidateQueries({ queryKey: ['songs'] }) }).catch((error) => setToast(String(error).replace(/^Error:\s*/, ''))) }} />
    {toast && <button className="toast" onClick={() => setToast('')}><AlertTriangle size={16} />{toast}<span>×</span></button>}
  </div>
}

function NoSongPractice({ onLibrary, onImport }: { onLibrary(): void; onImport(): void }): React.JSX.Element {
  return <main className="page no-song-practice"><span><Library size={38} /></span><h1>还没有正在练习的歌曲</h1><p>从曲库选择一首已完成分轨的歌曲，或先导入新歌曲。</p><div><button className="outline-button" onClick={onLibrary}>返回曲库</button><button className="primary-button" onClick={onImport}><Plus size={18} />导入歌曲</button></div></main>
}

function useKeyboardShortcuts({
  song, practice, currentMs, selectedStem, seek, togglePlayback, patchPractice, patchTrack, setSelectedStem
}: {
  song: SongDetail | null
  practice: PracticeState | null
  currentMs: number
  selectedStem: StemType
  seek(milliseconds: number): void
  togglePlayback(): Promise<void>
  patchPractice(patch: Partial<PracticeState>): void
  patchTrack(stem: StemType, patch: Partial<PracticeState['tracks'][number]>): void
  setSelectedStem(stem: StemType): void
}): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!song || !practice || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]') || target?.closest('[data-dialog-open="true"], [role="menu"]')) return
      const selected = practice.tracks.find((track) => track.stemType === selectedStem)
      const index = STEM_ORDER.indexOf(selectedStem)
      if (event.code === 'Space') { event.preventDefault(); void togglePlayback() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(currentMs - (event.shiftKey ? 1000 : 5000)) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(currentMs + (event.shiftKey ? 1000 : 5000)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedStem(STEM_ORDER[Math.max(0, index - 1)]!) }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedStem(STEM_ORDER[Math.min(STEM_ORDER.length - 1, index + 1)]!) }
      else if (event.key.toLowerCase() === 'a') patchPractice({ loopStartMs: currentMs, ...(practice.loopEndMs !== null && practice.loopEndMs <= currentMs ? { loopEndMs: null, loopEnabled: false } : {}) })
      else if (event.key.toLowerCase() === 'b' && (practice.loopStartMs === null || currentMs > practice.loopStartMs)) patchPractice({ loopEndMs: currentMs })
      else if (event.key.toLowerCase() === 'l') patchPractice({ loopEnabled: practice.loopStartMs !== null && practice.loopEndMs !== null ? !practice.loopEnabled : false })
      else if (event.key.toLowerCase() === 'm' && selected) patchTrack(selectedStem, { muted: !selected.muted })
      else if (event.key.toLowerCase() === 's' && selected) patchTrack(selectedStem, { solo: !selected.solo })
      else if ((event.key === '+' || event.key === '=') && selected) patchTrack(selectedStem, { gainDb: clamp(selected.gainDb + 1, -60, 6) })
      else if (event.key === '-' && selected) patchTrack(selectedStem, { gainDb: clamp(selected.gainDb - 1, -60, 6) })
      else if (event.key === '0' && selected) patchTrack(selectedStem, { gainDb: 0 })
      else if (event.key === 'Escape') patchPractice({ loopStartMs: null, loopEndMs: null, loopEnabled: false })
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [song, practice, currentMs, selectedStem, seek, togglePlayback, patchPractice, patchTrack, setSelectedStem])
}
