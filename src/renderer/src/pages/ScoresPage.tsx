import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { BookOpen, ChevronLeft, ChevronRight, Download, Library, Pause, Play, Plus, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react'
import { scoreTimeToBeat, type ScoreModel, type ScorePractice, type ScoreProject, type ScoreRuntime, type ScoreSettings } from '@shared/scores.js'
import { STEM_META } from '@shared/domain.js'
import { ScoreAudio } from '../scores/audio.js'
import { PianoRoll, TRACK_COLORS } from '../scores/PianoRoll.js'
import { ScoreNotation } from '../scores/Notation.js'
import { useRecordingSession } from '../recording-session.js'
import '../scores/scores.css'

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const activeJob = (p: ScoreProject): boolean => ['queued', 'blockedRuntime', 'preparing', 'transcribing', 'postprocessing', 'cancelling'].includes(p.status)
const modelNames = { small: '轻量 · Small', medium: '均衡 · Medium', large: '高质量 · Large' }
const defaultPractice: ScorePractice = { rate: 1, position: 0, loop: null, tracks: {} }

export default function ScoresPage({ active, outputDeviceId = '', sourceSongId, onSourceHandled, onToast }: { active: boolean; outputDeviceId?: string; sourceSongId?: string | null; onSourceHandled(): void; onToast(message: string): void }): React.JSX.Element {
  const client = useQueryClient(), audio = useRef<ScoreAudio | null>(null)
  if (!audio.current) audio.current = new ScoreAudio()
  useEffect(() => { if (!audio.current) audio.current = new ScoreAudio(); return () => { audio.current?.destroy(); audio.current = null } }, [])
  const [id, setId] = useState<string | null>(null), [search, setSearch] = useState(''), [libraryOpen, setLibraryOpen] = useState(false), [initialSong, setInitialSong] = useState<string | null>(null)
  const [runtimeOpen, setRuntimeOpen] = useState(false), [view, setView] = useState<'roll' | 'staff' | 'tab'>('roll')
  const [selected, setSelected] = useState<string[]>([]), [practice, setPractice] = useState<ScorePractice>(defaultPractice)
  const [position, setPosition] = useState(0), [playing, setPlaying] = useState(false), [busy, setBusy] = useState(false), [follow, setFollow] = useState(true), [browseBar, setBrowseBar] = useState(0)
  const [model, setModel] = useState<ScoreModel>('small'), [device, setDevice] = useState<ScoreProject['device']>('auto')
  const [exportOpen, setExportOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [deleteConfirm, setDeleteConfirm] = useState(false)
  const recording = useRecordingSession()
  const list = useQuery({ queryKey: ['score-list'], queryFn: () => window.bandbuddy.scores.list(), networkMode: 'always' })
  const runtime = useQuery({ queryKey: ['score-runtime'], queryFn: () => window.bandbuddy.scores.runtime(), networkMode: 'always' })
  const summary = list.data?.find(p => p.id === id)
  const detail = useQuery({ queryKey: ['score-detail', id, summary?.activeRun], queryFn: () => window.bandbuddy.scores.get(id!), enabled: Boolean(id), retry: false, networkMode: 'always' })
  const project = useMemo(() => detail.data ? { ...detail.data, ...summary, data: detail.data.data } : null, [detail.data, summary])
  const practiceRef = useRef(practice), idRef = useRef(id); practiceRef.current = practice; idRef.current = id
  const refresh = (): void => { void client.invalidateQueries({ queryKey: ['score-list'] }); void client.invalidateQueries({ queryKey: ['score-runtime'] }) }
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = window.bandbuddy.scores.onChanged(() => { if (!timer) timer = setTimeout(() => { timer = undefined; refresh() }, 250) })
    return () => { unsub(); if (timer) clearTimeout(timer) }
  }, [])
  useEffect(() => {
    if (sourceSongId) { setInitialSong(sourceSongId); setLibraryOpen(true); onSourceHandled() }
  }, [sourceSongId])
  useEffect(() => {
    if (!project) return
    audio.current!.pause(); setPlaying(false); setPosition(project.practice.position); setPractice(project.practice)
    setSelected(project.data?.tracks.map(t => t.id) ?? []); setModel(project.model); setDevice(project.device); setBrowseBar(0)
  }, [project?.id, project?.activeRun])
  useEffect(() => { void audio.current!.setOutput(outputDeviceId).catch(e => onToast(String(e))) }, [outputDeviceId])
  useEffect(() => { if (recording) { audio.current!.pause(); setPlaying(false) } }, [recording])
  useEffect(() => {
    let wasPlaying = audio.current!.playing, playingId = idRef.current
    const timer = setInterval(() => {
      const a = audio.current!
      if (a.playing && active) setPosition(a.position)
      if (wasPlaying && !a.playing && playingId === idRef.current && playingId) {
        const next = { ...practiceRef.current, position: a.position }
        setPosition(a.position); setPractice(next)
        void window.bandbuddy.scores.savePractice(playingId, next).catch(() => {})
      }
      wasPlaying = a.playing; if (a.playing) playingId = idRef.current
      setPlaying(a.playing)
    }, active ? 40 : 250)
    return () => clearInterval(timer)
  }, [active])
  useEffect(() => {
    const timer = setInterval(() => { if (idRef.current && audio.current!.playing) void window.bandbuddy.scores.savePractice(idRef.current, { ...practiceRef.current, position: audio.current!.position }).catch(() => {}) }, 5000)
    return () => { clearInterval(timer) }
  }, [])
  const act = async (fn: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await fn(); refresh() } catch (e) { onToast(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const open = (next: string | null): void => { audio.current!.pause(); if (id) void window.bandbuddy.scores.savePractice(id, { ...practice, position }).catch(() => {}); setId(next); setDeleteConfirm(false) }
  const update = (next: ScorePractice): void => { setPractice(next); audio.current!.setMix(next); if (id) void window.bandbuddy.scores.savePractice(id, next).catch(e => onToast(String(e))) }
  const play = async (): Promise<void> => {
    if (!project?.data) return
    if (audio.current!.playing) { audio.current!.pause(); setPlaying(false); update({ ...practice, position: audio.current!.position }); return }
    if (!runtime.data?.soundfont) { setRuntimeOpen(true); return }
    setPlaying(await audio.current!.play(project.data, { ...practice, position }, project.title, outputDeviceId))
  }
  const seek = (next: number): void => { setPosition(next); update({ ...practice, position: next }); void audio.current!.seek(next).catch(e => onToast(String(e))) }
  const changeLoop = (loop: ScorePractice['loop']): void => {
    const next = { ...practice, position, loop }; update(next)
    if (playing && project?.data) void act(async () => { await audio.current!.play(project.data!, next, project.title, outputDeviceId) })
  }
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || (e.target as HTMLElement)?.closest('input,textarea,select,button,[role="dialog"]') || !project?.data) return
      e.preventDefault(); void act(play)
    }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [active, project, position, practice, runtime.data])
  const currentBar = project?.data ? Math.max(0, Math.floor(scoreTimeToBeat(project.data.tempo, position) / (project.data.tempo.numerator * 4 / project.data.tempo.denominator))) : 0
  const pageBar = follow ? Math.floor(currentBar / 8) * 8 : browseBar
  const totalBars = project?.data ? Math.max(1, Math.ceil(scoreTimeToBeat(project.data.tempo, project.data.duration) / (project.data.tempo.numerator * 4 / project.data.tempo.denominator))) : 1
  const trackIds = selected.length ? selected : project?.data?.tracks.map(t => t.id) ?? []
  const availableTab = project?.data?.tracks.some(t => trackIds.includes(t.id) && /guitar|bass/.test(t.instrument))

  return <main className="page scores-page">
    <header className="score-heading"><div><span className="score-eyebrow">BANDBUDDY / 藏经阁</span><h1>{project ? project.title : '把听见的，留在谱上。'}</h1><p>{project ? `${project.data?.tracks.length ?? 0} 条乐器轨 · ${project.sources.length > 1 ? '分离轨转谱' : '整曲转谱'} · ${project.data ? clock(project.data.duration) : '等待生成'}` : '从一首歌开始，拆解音符，逐轨练习。'}</p></div>
      <div className="score-heading-actions">{id && <button className="outline-button" onClick={() => open(null)}><ChevronLeft size={16} />谱库</button>}<button className="outline-button" onClick={() => setRuntimeOpen(true)}><Settings2 size={16} />转谱组件{runtime.data?.busy && ' · 准备中'}</button><button className="outline-button" onClick={() => { setInitialSong(null); setLibraryOpen(true) }}><Library size={16} />从曲库选择</button><button className="primary-button" disabled={busy} onClick={() => void act(async () => { const p = await window.bandbuddy.scores.create({}); if (p) open(p.id) })}><Plus size={16} />导入音频</button></div>
    </header>
    {list.error && <p className="score-error" role="alert">{list.error.message}<button onClick={refresh}>重试</button></p>}
    {!id ? <section className="score-library">
      <div className="score-library-top"><h2>我的乐谱 <span>{list.data?.length ?? 0}</span></h2><label className="score-search"><Search size={16} /><input aria-label="搜索乐谱" placeholder="搜索乐谱…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      {list.isPending ? <p role="status">正在读取谱库…</p> : !list.data?.length ? <div className="score-empty"><BookOpen size={48} strokeWidth={1} /><h2>第一卷，从你喜欢的歌开始</h2><p>导入音频，或选择曲库里的原曲与分离轨。<br />转成 MIDI 后，在这里看谱、试听和循环练习。</p><button className="primary-button" onClick={() => void act(async () => { const p = await window.bandbuddy.scores.create({}); if (p) open(p.id) })}>导入第一首歌</button><small>本地转谱 · 首次使用需下载模型 · 非商业用途</small></div> : <div className="score-book-list">{list.data.filter(p => p.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((p, i) => <button className="score-book" key={p.id} onClick={() => open(p.id)}><span className="score-book-number">{String(i + 1).padStart(2, '0')}</span><BookOpen size={23} /><span className="score-book-name"><b>{p.title}</b><small>{p.sources.length > 1 ? `${p.sources.length} 条来源轨` : '整曲转谱'} · {modelNames[p.model]}{p.openedAt ? ` · 最近打开 ${new Date(p.openedAt).toLocaleDateString()}` : ''}</small></span><span className={`score-book-status ${p.status}`}>{activeJob(p) ? `${p.phase} ${Math.round(p.progress * 100)}%` : p.activeRun ? '查看乐谱' : p.status === 'failed' ? '转谱未完成' : '等待转谱'}</span><ChevronRight size={18} /></button>)}</div>}
    </section> : !project ? <div className="score-placeholder" role="status">{detail.error ? `读取乐谱失败：${detail.error.message}` : '正在打开乐谱…'}</div> : <>
      <div className="score-convert-bar"><label>转谱模型 <select aria-label="转谱模型" disabled={activeJob(project)} value={model} onChange={e => setModel(e.target.value as ScoreModel)}>{Object.entries(modelNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label><label>计算设备 <select aria-label="转谱设备" value={device} disabled={activeJob(project)} onChange={e => setDevice(e.target.value as ScoreProject['device'])}><option value="auto">自动</option><option value="cpu">CPU</option><option value="cuda">CUDA</option><option value="mps">Apple MPS</option></select></label>
        <button className="primary-button" disabled={busy || activeJob(project)} onClick={() => void act(async () => { await window.bandbuddy.scores.transcribe(project.id, model, device); if (!runtime.data?.ready || !runtime.data.models[model]) setRuntimeOpen(true) })}><RefreshCw size={15} />{project.activeRun ? '重新转谱' : '开始转谱'}</button>
        {activeJob(project) && project.jobId && <button className="outline-button" onClick={() => void act(() => window.bandbuddy.tasks.cancel(project.jobId!))}>取消任务</button>}
        <span className="score-phase" role="status">{project.phase}{activeJob(project) && ` · ${Math.round(project.progress * 100)}%`}</span>
        <button className="quiet-button" title="删除乐谱" aria-label="删除乐谱" onClick={() => setDeleteConfirm(true)}><Trash2 size={17} /></button>
      </div>
      {project.error && <p className="score-error" role="alert">{project.error} {project.jobId && <button onClick={() => void act(() => window.bandbuddy.tasks.retry(project.jobId!, true))}>使用 CPU 重试</button>}</p>}
      {project.data ? <>
        <div className="score-workspace"><aside className="score-tracks"><div className="score-tracks-title"><b>乐器分轨</b><button onClick={() => setSelected(project.data!.tracks.map(t => t.id))}>全选</button></div>{project.data.tracks.map((track, index) => {
          const t = practice.tracks[track.id] ?? { mute: false, solo: false, volume: .8 }
          const patch = (v: Partial<typeof t>): void => update({ ...practice, tracks: { ...practice.tracks, [track.id]: { ...t, ...v } } })
          return <article className={`score-track ${trackIds.includes(track.id) ? 'selected' : ''}`} key={track.id} style={{ '--track-color': TRACK_COLORS[index % TRACK_COLORS.length] } as React.CSSProperties}><div><input type="checkbox" aria-label={`显示 ${track.name}`} checked={trackIds.includes(track.id)} onChange={e => setSelected(e.target.checked ? [...trackIds, track.id] : trackIds.length > 1 ? trackIds.filter(id => id !== track.id) : trackIds)} /><button className="score-track-name" onClick={() => setSelected([track.id])}>{track.name}</button></div><small>{track.notes.length} 个音符{track.isDrum ? ' · 鼓组' : ''}</small><div className="score-track-mix"><button aria-label={`${track.name} 独奏`} aria-pressed={t.solo} onClick={() => patch({ solo: !t.solo })}>S</button><button aria-label={`${track.name} 静音`} aria-pressed={t.mute} onClick={() => patch({ mute: !t.mute })}>M</button><input type="range" aria-label={`${track.name} 音量`} min={0} max={1} step={.01} value={t.volume} onChange={e => patch({ volume: Number(e.target.value) })} /></div></article>
        })}</aside>
        <section className="score-sheet"><div className="score-view-tools"><div className="score-view-tabs" role="tablist" aria-label="谱面视图">{([['roll', '钢琴卷帘'], ['staff', '五线谱'], ['tab', 'TAB 指法']] as const).map(([key, label]) => <button role="tab" aria-selected={view === key} key={key} disabled={key === 'tab' && !availableTab} onClick={() => setView(key)}>{label}</button>)}</div><div><label className="score-follow"><input type="checkbox" checked={follow} onChange={e => { setFollow(e.target.checked); setBrowseBar(pageBar) }} />跟随播放</label><button className="quiet-button" onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} />记谱设置</button><button className="outline-button" onClick={() => setExportOpen(true)}><Download size={15} />导出</button></div></div>
          {settingsOpen && <NotationSettings project={project} disabled={busy || activeJob(project)} onSave={settings => void act(() => window.bandbuddy.scores.render(project.id, settings))} />}
          {project.data.tempo.provisional && <p className="score-notice">节拍网格待确认，可在记谱设置中调整 BPM、拍号与首拍。</p>}
          <div className="score-sheet-content">{view === 'tab' && <p className="score-notice">TAB 为推荐指法；缺失弦位的音符会标注“指法待确认”，完整音高保留在五线谱与卷帘中。</p>}{view === 'roll' ? <PianoRoll data={project.data} trackIds={trackIds} position={position} follow={follow} onSeek={seek} /> : <><div className="score-page-controls"><button aria-label="上一页乐谱" disabled={pageBar === 0} onClick={() => { setFollow(false); setBrowseBar(Math.max(0, pageBar - 8)) }}><ChevronLeft size={16} /></button><span>第 {pageBar + 1}–{Math.min(totalBars, pageBar + 8)} 小节 · 当前第 {currentBar + 1} 小节</span><button aria-label="下一页乐谱" disabled={pageBar + 8 >= totalBars} onClick={() => { setFollow(false); setBrowseBar(pageBar + 8) }}><ChevronRight size={16} /></button></div><ScoreNotation project={project} trackIds={trackIds} tab={view === 'tab'} bar={pageBar} position={position} onSeek={seek} /></>}</div>
          {project.data.warnings.length > 0 && <details className="score-warnings"><summary>转谱提示 · {project.data.warnings.length}</summary>{[...new Set(project.data.warnings)].map((w, i) => <p key={i}>{w}</p>)}</details>}
        </section></div>
        <footer className="score-transport"><button className="score-play" aria-label={playing ? '暂停 MIDI' : '播放 MIDI'} disabled={busy || Boolean(recording)} onClick={() => void act(play)}>{playing ? <Pause size={23} /> : <Play size={23} />}</button><span className="score-time">{clock(position)} / {clock(project.data.duration)}</span><input className="score-seek" aria-label="播放位置" type="range" min={0} max={project.data.duration} step={.01} value={position} onChange={e => seek(Number(e.target.value))} /><label>速度 <select aria-label="MIDI 播放速度" value={practice.rate} onChange={e => update({ ...practice, rate: Number(e.target.value) })}>{[.5,.75,1,1.25,1.5,2,2.5,3].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label><button aria-label="设置 A 点" className={practice.loop ? 'active' : ''} onClick={() => changeLoop({ a: Math.min(position, project.data!.duration - .1), b: project.data!.duration })}>A</button><button aria-label="设置 B 点" disabled={!practice.loop || position <= practice.loop.a + .05} onClick={() => changeLoop({ a: practice.loop!.a, b: position })}>B</button><button aria-label="取消 AB 循环" disabled={!practice.loop} onClick={() => changeLoop(null)}>{practice.loop ? `${clock(practice.loop.a)}–${clock(practice.loop.b)} ×` : 'AB 循环'}</button></footer>
      </> : <div className="score-awaiting"><BookOpen size={44} strokeWidth={1} /><h2>{activeJob(project) ? '音符正在归卷' : '素材已准备好'}</h2><p>{activeJob(project) ? project.phase : '选择模型，开始生成这首歌的分轨 MIDI 与乐谱。'}</p>{activeJob(project) && <progress aria-label="转谱进度" value={project.progress} max={1} />}{project.sources.map(s => <span key={s.id}>{s.name} · {clock(s.duration)}</span>)}</div>}
    </>}
    <LibraryPicker open={libraryOpen} initialSong={initialSong} onClose={() => setLibraryOpen(false)} onCreate={input => void act(async () => { const p = await window.bandbuddy.scores.create(input); if (p) { setLibraryOpen(false); open(p.id) } })} />
    <RuntimeDialog open={runtimeOpen} onClose={() => setRuntimeOpen(false)} runtime={runtime.data} model={model} onModel={setModel} run={act} />
    {project && <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} count={trackIds.length} run={(format, quantized, tab) => void act(async () => { const file = await window.bandbuddy.scores.export(project.id, trackIds, format, quantized, tab); if (file) { onToast('乐谱已导出'); setExportOpen(false) } })} />}
    <Modal open={deleteConfirm} title="删除乐谱" onClose={() => setDeleteConfirm(false)}><p>删除“{project?.title}”及其转谱结果和音频副本？曲库中的歌曲会保留。</p><button className="primary-button" disabled={busy} onClick={() => void act(async () => { if (id) { audio.current!.pause(); await window.bandbuddy.scores.delete(id); open(null) } })}>删除</button></Modal>
  </main>
}

function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: React.ReactNode }): React.JSX.Element {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content score-dialog" aria-describedby={undefined}><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="dialog-close" aria-label="关闭"><X size={18} /></Dialog.Close>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
}
function LibraryPicker({ open, initialSong, onClose, onCreate }: { open: boolean; initialSong: string | null; onClose(): void; onCreate(input: { songId: string; stemIds?: string[] }): void }): React.JSX.Element {
  const [query, setQuery] = useState(''), [songId, setSongId] = useState<string | null>(null), [mode, setMode] = useState<'mix' | 'stems'>('mix'), [stems, setStems] = useState<string[]>([])
  useEffect(() => { if (open) { setSongId(initialSong); setStems([]); setMode('mix') } }, [open, initialSong])
  const songs = useQuery({ queryKey: ['score-source-songs', query], queryFn: () => window.bandbuddy.library.listPage({ query, limit: 50 }), enabled: open, networkMode: 'always' })
  const song = useQuery({ queryKey: ['score-source-song', songId], queryFn: () => window.bandbuddy.library.get(songId!), enabled: open && Boolean(songId), networkMode: 'always' })
  useEffect(() => { if (song.data?.sourceFormat === 'existing-stems' || song.data?.sourceFormat === null) setMode('stems') }, [song.data])
  return <Modal open={open} title="从曲库转谱" onClose={onClose}>
    <input className="score-input" placeholder="搜索歌曲…" aria-label="搜索来源歌曲" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="score-source-list">{songs.data?.items.map(s => <button className={songId === s.id ? 'active' : ''} key={s.id} onClick={() => { setSongId(s.id); setStems([]) }}>{s.title}<small>{s.artist}</small></button>)}</div>
    {song.data && <><div className="score-radio"><label><input type="radio" checked={mode === 'mix'} disabled={!song.data.sourceFormat || song.data.sourceFormat === 'existing-stems'} onChange={() => setMode('mix')} />整曲自动识别</label><label><input type="radio" checked={mode === 'stems'} onChange={() => setMode('stems')} />选择分离轨</label></div>{mode === 'stems' && <div className="score-source-stems">{song.data.stems.map(s => <label key={s.id}><input type="checkbox" checked={stems.includes(s.id)} onChange={e => setStems(e.target.checked ? [...stems, s.id] : stems.filter(id => id !== s.id))} />{s.name || STEM_META[s.type].label}</label>)}</div>}<p className="score-help">{mode === 'mix' ? '整曲按乐器类别归轨，同类乐器可能合并。若要保留主音与节奏吉他，请选择分离轨。' : '分别转谱并保留原轨名与时间位置。各来源轨独立保存，不会合并同类乐器。'}</p></>}
    <button className="primary-button" disabled={!songId || !song.data || mode === 'stems' && !stems.length} onClick={() => onCreate({ songId: songId!, ...(mode === 'stems' ? { stemIds: stems } : {}) })}>加入藏经阁</button>
  </Modal>
}
function RuntimeDialog({ open, onClose, runtime, model, onModel, run }: { open: boolean; onClose(): void; runtime?: ScoreRuntime; model: ScoreModel; onModel(v: ScoreModel): void; run(fn: () => Promise<unknown>): Promise<void> }): React.JSX.Element {
  const [accepted, setAccepted] = useState(false), [token, setToken] = useState('')
  return <Modal open={open} title="转谱组件" onClose={onClose}><p>首次准备完成后，音频转谱、看谱与播放均可离线使用。</p><label className="score-field">模型<select value={model} onChange={e => onModel(e.target.value as ScoreModel)}>{Object.entries(modelNames).map(([key, name]) => <option key={key} value={key}>{name} · {key === 'small' ? '412 MB' : key === 'medium' ? '1.23 GB' : '5.47 GB'}{runtime?.models[key as ScoreModel] ? ' · 已就绪' : ''}</option>)}</select></label><div className="score-license"><b>Muscriptor · 非商业许可</b><p>代码采用 MIT；模型权重采用 CC BY-NC 4.0，并附有使用条件。请使用有权转谱的音频。</p><a href={`https://huggingface.co/MuScriptor/muscriptor-${model}`} target="_blank" rel="noreferrer">查看模型说明与访问条件 ↗</a><label><input type="checkbox" checked={accepted || Boolean(runtime?.accepted)} onChange={e => setAccepted(e.target.checked)} disabled={runtime?.accepted} />我已阅读并接受模型许可及访问条件</label></div><label className="score-field">Hugging Face 读取 Token<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={runtime?.hasToken ? '已安全保存；留空继续使用' : '在官方页面接受访问条件后填写'} /></label><p className="score-help">Token 仅用于模型下载，通过系统加密保存。也可导入官方模型目录。</p><div className="score-dialog-actions"><button className="primary-button" disabled={runtime?.busy || !(accepted || runtime?.accepted)} onClick={() => void run(async () => { await window.bandbuddy.scores.prepare({ acceptLicense: accepted || Boolean(runtime?.accepted), model, ...(token.trim() ? { token: token.trim() } : {}) }); setToken('') })}>下载并准备</button><button className="outline-button" disabled={runtime?.busy || !(accepted || runtime?.accepted)} onClick={() => void run(() => window.bandbuddy.scores.prepare({ acceptLicense: accepted || Boolean(runtime?.accepted), model, importLocal: true }))}>导入模型目录</button>{runtime?.busy && <button className="outline-button" onClick={() => void run(() => window.bandbuddy.scores.cancelPreparation())}>取消</button>}</div><p role="status">{runtime?.stage ?? '正在读取组件状态…'}</p>{runtime?.progress != null && <progress value={runtime.progress} max={1} aria-label="组件准备进度" />}{runtime?.error && <p className="score-error" role="alert">{runtime.error}</p>}</Modal>
}
function NotationSettings({ project, disabled, onSave }: { project: ScoreProject; disabled: boolean; onSave(v: ScoreSettings): void }): React.JSX.Element {
  const [draft, setDraft] = useState(project.settings)
  useEffect(() => setDraft(project.settings), [project.activeRun])
  return <div className="score-notation-settings"><label>BPM<input aria-label="记谱 BPM" type="number" min={20} max={400} placeholder="自动" value={draft.bpm ?? ''} onChange={e => setDraft({ ...draft, bpm: e.target.value ? Number(e.target.value) : null })} /></label><label>拍号<select aria-label="记谱拍号" value={draft.numerator ? `${draft.numerator}/${draft.denominator}` : 'auto'} onChange={e => { const [n, d] = e.target.value.split('/').map(Number); setDraft({ ...draft, numerator: n || null, denominator: d === 8 ? 8 : 4 }) }}><option value="auto">自动</option>{['2/4','3/4','4/4','5/4','6/8','7/8'].map(m => <option key={m}>{m}</option>)}</select></label><label>首拍（秒）<input aria-label="首拍位置" type="number" min={0} step={.01} placeholder="自动" value={draft.firstDownbeat ?? ''} onChange={e => setDraft({ ...draft, firstDownbeat: e.target.value ? Number(e.target.value) : null })} /></label><label>量化<select aria-label="量化网格" value={draft.subdivision} onChange={e => setDraft({ ...draft, subdivision: Number(e.target.value) as ScoreSettings['subdivision'] })}><option value={2}>八分音符</option><option value={4}>十六分音符</option><option value={8}>三十二分音符</option><option value={3}>八分三连音</option><option value={6}>十六分三连音</option></select></label>{project.data?.tracks.filter(t => /guitar|bass/.test(t.instrument)).map(t => <label key={t.id}>{t.name}<select aria-label={`${t.name} 调弦`} value={draft.tunings[t.id] ?? (t.instrument.includes('bass') ? 'bass' : 'guitar')} onChange={e => setDraft({ ...draft, tunings: { ...draft.tunings, [t.id]: e.target.value as 'guitar' } })}>{(t.instrument.includes('bass') ? [['bass','四弦标准'],['bass-5','五弦标准']] : [['guitar','六弦标准'],['drop-d','Drop D']]).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>)}<button className="outline-button" disabled={disabled} onClick={() => onSave(draft)}>重新生成谱面</button><small>保留原始音符，无需重新转谱。</small></div>
}
function ExportDialog({ open, onClose, count, run }: { open: boolean; onClose(): void; count: number; run(format: 'midi' | 'musicxml', quantized: boolean, tab: boolean): void }): React.JSX.Element {
  const [format, setFormat] = useState<'midi' | 'musicxml'>('midi'), [quantized, setQuantized] = useState(true), [tab, setTab] = useState(false)
  return <Modal open={open} title="导出乐谱" onClose={onClose}><p>导出当前选中的 {count} 条乐器轨。</p><label className="score-field">格式<select aria-label="导出格式" value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="midi">MIDI · 多轨 Type 1</option><option value="musicxml">MusicXML · 可继续编辑的乐谱</option></select></label>{format === 'midi' ? <label><input type="checkbox" checked={quantized} onChange={e => setQuantized(e.target.checked)} />量化时值（取消勾选保留演奏时间）</label> : <label><input type="checkbox" checked={tab} onChange={e => setTab(e.target.checked)} />包含吉他／贝斯 TAB</label>}<div className="score-dialog-actions"><button className="primary-button" onClick={() => run(format, quantized, tab)}><Download size={16} />选择保存位置</button></div></Modal>
}
