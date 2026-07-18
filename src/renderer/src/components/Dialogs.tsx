import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertTriangle,
  Check,
  Download,
  FileAudio,
  FolderOpen,
  Gauge,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  STEM_META,
  STEM_ORDER,
  type AppSettings,
  type ExportFormat,
  type JobRecord,
  type PracticeState,
  type RuntimeInfo,
  type SongDetail,
  type SongSummary,
  type StemChoice,
  type StemType
} from '@shared/domain.js'
import { formatDate, statusLabel } from '../utils.js'

export function ImportDialog({
  open,
  onOpenChange,
  onImported,
  onOpenDuplicate,
  onNeedsRuntime
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onImported(songId: string, warnings: string[]): void
  onOpenDuplicate(songId: string): void
  onNeedsRuntime(): void
}): React.JSX.Element {
  const [mode, setMode] = useState<'song' | 'stems'>('song')
  const [source, setSource] = useState<{ path: string; name: string } | null>(null)
  const [stems, setStems] = useState<StemChoice[]>([])
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [duplicate, setDuplicate] = useState<{ id: string; title: string } | null>(null)
  const [needsPadding, setNeedsPadding] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(''); setDuplicate(null); setNeedsPadding(false)
  }, [open])

  const chooseSource = async (): Promise<void> => {
    const choice = await window.bandbuddy.library.chooseSource()
    if (!choice) return
    setSource(choice)
    if (!title) setTitle(choice.inferredTitle)
  }

  const chooseStems = async (choiceMode: 'files' | 'folder'): Promise<void> => {
    const choices = await window.bandbuddy.library.chooseStems(choiceMode)
    if (!choices.length) return
    setStems(choices)
    if (!title) {
      const first = choices[0]
      if (first) setTitle(first.name.replace(/\.[^.]+$/, '').replace(/[-_ ]?(vocals?|drums?|bass|guitar|piano|other|人声|鼓组|贝斯|吉他|钢琴|其他)$/i, ''))
    }
  }

  const submit = async (forceDuplicate = false, padMismatched = false): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (mode === 'song') {
        if (!source) throw new Error('请先选择一首歌曲')
        const result = await window.bandbuddy.library.importSource({ filePath: source.path, title, artist, forceDuplicate })
        if (result.duplicate) { setDuplicate({ id: result.duplicate.id, title: result.duplicate.title }); return }
        if (result.songId) {
          onOpenChange(false); onImported(result.songId, result.warnings); onNeedsRuntime()
        }
      } else {
        const files = stems.filter((stem): stem is StemChoice & { inferredType: StemType } => stem.inferredType !== null)
        if (files.length < 2) throw new Error('至少需要两条已分类音轨')
        if (new Set(files.map((file) => file.inferredType)).size !== files.length) throw new Error('每种音轨类型只能选择一次')
        const result = await window.bandbuddy.library.importStems({ files: files.map((file) => ({ path: file.path, type: file.inferredType })), title, artist, padMismatched })
        if (result.needsPadding) { setNeedsPadding(true); return }
        if (result.songId) { onOpenChange(false); onImported(result.songId, result.warnings) }
      }
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" data-dialog-open="true" />
      <Dialog.Content className="dialog-content import-dialog" data-dialog-open="true" aria-describedby={undefined}>
        <Dialog.Title>导入音乐</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close>
        <p className="dialog-lead">源文件会复制到受管曲库，音频处理全部在本机完成。</p>
        <div className="dialog-tabs"><button className={mode === 'song' ? 'active' : ''} onClick={() => setMode('song')}><FileAudio size={18} />导入歌曲</button><button className={mode === 'stems' ? 'active' : ''} onClick={() => setMode('stems')}><SlidersHorizontal size={18} />导入现有分轨</button></div>
        {mode === 'song' ? <div className={`drop-zone ${source ? 'selected' : ''}`} onClick={() => void chooseSource()}>
          <span>{source ? <Check size={25} /> : <Upload size={25} />}</span><b>{source?.name ?? '选择 MP3、WAV、FLAC、M4A 或 AAC'}</b><small>{source ? '点击重新选择' : '支持中文、空格与 Emoji 路径'}</small>
        </div> : <>
          <div className="stem-pick-actions"><button className="outline-button" onClick={() => void chooseStems('files')}><FileAudio size={17} />选择多个文件</button><button className="outline-button" onClick={() => void chooseStems('folder')}><FolderOpen size={17} />选择文件夹</button></div>
          <div className="stem-mapping">{stems.length === 0 ? <p>BandBuddy 会按常见中英文文件名自动识别，导入前可手动改类。</p> : stems.map((stem, index) => <label key={`${stem.path}-${index}`}><span title={stem.path}>{stem.name}</span><select value={stem.inferredType ?? ''} onChange={(event) => setStems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, inferredType: (event.target.value || null) as StemType | null } : item))}><option value="">暂不导入</option>{STEM_ORDER.map((type) => <option value={type} key={type}>{STEM_META[type].shortLabel} · {STEM_META[type].label}</option>)}</select></label>)}</div>
        </>}
        <div className="form-row"><label>歌曲标题<input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可选，默认使用文件名" /></label><label>艺术家<input maxLength={200} value={artist} onChange={(event) => setArtist(event.target.value)} placeholder="可选" /></label></div>
        {duplicate && <div className="inline-warning"><AlertTriangle /><span><b>曲库已有“{duplicate.title}”</b><small>可打开已有歌曲，或仍然创建一份副本。</small></span><button onClick={() => { onOpenChange(false); onOpenDuplicate(duplicate.id) }}>打开已有</button><button onClick={() => void submit(true)}>仍创建副本</button></div>}
        {needsPadding && <div className="inline-warning"><AlertTriangle /><span><b>音轨时长差超过 500 ms</b><small>BandBuddy 不会猜测性对齐；确认后只在末尾补静音。</small></span><button onClick={() => void submit(false, true)}>确认补静音</button></div>}
        {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
        <footer className="dialog-footer"><Dialog.Close className="outline-button">取消</Dialog.Close><button className="primary-button" disabled={busy || (mode === 'song' ? !source : stems.length < 2)} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={17} />}导入并处理</button></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function TasksDrawer({ open, onOpenChange, jobs, onRefresh }: { open: boolean; onOpenChange(open: boolean): void; jobs: JobRecord[]; onRefresh(): void }): React.JSX.Element {
  const active = jobs.filter((job) => ['queued', 'blockedRuntime', 'preparing', 'separating', 'postprocessing', 'cancelling'].includes(job.status))
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="drawer" data-dialog-open="true" aria-describedby={undefined}>
    <Dialog.Title>任务</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close><p className="dialog-lead">分离任务单线程运行，导出与标准化会依次进入队列。</p>
    <div className="drawer-summary"><Gauge /><span><b>{active.length ? `${active.length} 个进行中任务` : '当前没有活动任务'}</b><small>{jobs.length} 条任务记录</small></span></div>
    <div className="task-list">{jobs.length === 0 ? <div className="drawer-empty"><Check /><b>任务列表是空的</b><span>导入歌曲后，分离进度会显示在这里。</span></div> : jobs.map((job) => <article key={job.id}>
      <header><span className={`task-dot ${job.status}`} /> <b>{job.type === 'separate' ? '分轨处理' : job.type === 'normalizeStems' ? '分轨标准化' : job.type === 'export' ? '音频导出' : '环境安装'}</b><em>{statusLabel(job.status)}</em></header>
      <p>{job.phase}</p><div className="progress-line"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div><small>{Math.round(job.progress * 100)}% · {formatDate(job.createdAt)}</small>
      {job.errorMessage && <pre>{job.errorCode}: {job.errorMessage.slice(0, 180)}</pre>}
      <footer>{['queued', 'blockedRuntime', 'preparing', 'separating', 'postprocessing'].includes(job.status) && <button onClick={() => void window.bandbuddy.tasks.cancel(job.id).then(onRefresh)}>取消</button>}{['failed', 'cancelled', 'interrupted'].includes(job.status) && <><button onClick={() => void window.bandbuddy.tasks.retry(job.id).then(onRefresh)}>重试</button>{job.errorCode === 'CUDA_OOM' && <button onClick={() => void window.bandbuddy.tasks.retry(job.id, true).then(onRefresh)}>使用 CPU 重试</button>}</>}</footer>
    </article>)}</div>
    <footer className="drawer-footer"><button className="outline-button" onClick={() => void window.bandbuddy.tasks.clearFinished().then(onRefresh)}><Trash2 size={16} />清除已完成</button><button className="outline-button" onClick={onRefresh}><RefreshCw size={16} />刷新</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function SettingsDrawer({
  open, onOpenChange, runtime, settings, onSaved, onRefresh
}: {
  open: boolean
  onOpenChange(open: boolean): void
  runtime: RuntimeInfo
  settings: AppSettings
  onSaved(settings: AppSettings): void
  onRefresh(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(settings)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [busy, setBusy] = useState(false)
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  useEffect(() => setDraft(settings), [settings, open])
  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return
    void navigator.mediaDevices.enumerateDevices().then((devices) => setAudioOutputs(devices.filter((device) => device.kind === 'audiooutput'))).catch(() => setAudioOutputs([]))
  }, [open])
  const changing = ['installing', 'downloadingModel', 'verifying', 'detecting'].includes(runtime.status)
  const action = async (operation: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await operation(); onRefresh() } finally { setBusy(false) } }
  const dataRoot = draft.libraryRoot.replace(/[\\/]+music$/i, '')
  const chooseDataRoot = async (): Promise<void> => {
    const selected = await window.bandbuddy.settings.chooseDataRoot(draft.libraryRoot)
    if (!selected) return
    setDraft({ ...draft, libraryRoot: selected.libraryRoot, runtimeRoot: selected.runtimeRoot, modelRoot: selected.modelRoot })
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="drawer settings-drawer" data-dialog-open="true" aria-describedby={undefined}>
    <Dialog.Close className="dialog-close"><X /></Dialog.Close><div className="settings-scroll">
    <Dialog.Title>设置</Dialog.Title><p className="dialog-lead">管理本地分离环境、音频设备与网络源。</p>
    <section className="settings-section"><h3><Zap />本地分离环境</h3>
      <div className={`runtime-card ${runtime.status}`}><header><span><i /><b>{statusLabel(runtime.status)}</b></span><em>{runtime.selectedDevice.toUpperCase()}</em></header><p>{runtime.stage}</p>{runtime.progress !== null && <div className="progress-line"><i style={{ width: `${runtime.progress * 100}%` }} /></div>}{runtime.error && <pre>{runtime.error.slice(0, 500)}</pre>}
        <dl><div><dt>Python</dt><dd>{runtime.pythonVersion ?? '—'}</dd></div><div><dt>PyTorch</dt><dd>{runtime.torchVersion ?? '—'}</dd></div><div><dt>CUDA</dt><dd>{runtime.cudaVersion ?? '—'}</dd></div><div><dt>Demucs</dt><dd>{runtime.demucsVersion ?? '—'}</dd></div></dl>
      </div>
      {runtime.gpu ? <div className="gpu-card"><Gauge /><span><b>{runtime.gpu.name}</b><small>驱动 {runtime.gpu.driverVersion} · {Math.round(runtime.gpu.memoryMb / 1024)} GB 显存</small></span></div> : <div className="gpu-card muted"><Gauge /><span><b>{runtime.selectedDevice === 'mps' ? 'Apple MPS 加速' : '未检测到 NVIDIA GPU'}</b><small>{runtime.selectedDevice === 'mps' ? '将使用 Apple 芯片 GPU；不可用时自动切换 CPU。' : '将自动使用 CPU 完成模型分轨。'}</small></span></div>}
      <div className="runtime-actions">{changing ? <button className="outline-button" onClick={() => void window.bandbuddy.runtime.cancel()}>取消当前操作</button> : runtime.status === 'ready' ? <><button className="outline-button" onClick={() => void action(() => window.bandbuddy.runtime.detect())}>重新检测</button><button className="outline-button" onClick={() => void action(() => window.bandbuddy.runtime.repair())}>修复环境</button></> : <button className="primary-button" onClick={() => setConfirmInstall(true)}><Download size={17} />安装本地环境</button>}</div>
      {confirmInstall && <div className="install-confirm"><HardDrive /><span><b>预计需要 8–15 GB 可用空间</b><small>会下载私有 CPython、Torch 和约 1 GB 模型；可取消并从缓存续传。</small></span><button className="primary-button small" disabled={busy} onClick={() => { setConfirmInstall(false); void action(() => window.bandbuddy.runtime.install()) }}>确认安装</button><button onClick={() => setConfirmInstall(false)}>稍后</button></div>}
      <div className="danger-actions"><button onClick={() => void action(() => window.bandbuddy.runtime.clearModel())}>清理模型缓存</button><button onClick={() => void action(() => window.bandbuddy.runtime.remove(false))}>卸载环境</button><button onClick={() => void action(() => window.bandbuddy.runtime.remove(true))}>环境与模型全部清理</button></div>
    </section>
    <section className="settings-section"><h3><SlidersHorizontal />性能与播放</h3><div className="settings-grid"><label>首选计算设备<select value={draft.preferredDevice} onChange={(event) => setDraft({ ...draft, preferredDevice: event.target.value as AppSettings['preferredDevice'] })}><option value="auto">自动：CUDA → MPS → CPU</option><option value="cuda">NVIDIA CUDA（不可用时回退）</option><option value="mps">Apple MPS（不可用时回退）</option><option value="cpu">CPU</option></select></label><label>关闭窗口时<select value={draft.closeToTrayWhileWorking ? 'tray' : 'quit'} onChange={(event) => setDraft({ ...draft, closeToTrayWhileWorking: event.target.value === 'tray' })}><option value="tray">有任务时留在托盘</option><option value="quit">直接退出</option></select></label><label>音频输出<select value={draft.audioOutputDeviceId} onChange={(event) => setDraft({ ...draft, audioOutputDeviceId: event.target.value })}><option value="">系统默认输出</option>{audioOutputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `音频输出 ${index + 1}`}</option>)}</select></label><label>延迟模式<select value={draft.latencyMode} onChange={(event) => setDraft({ ...draft, latencyMode: event.target.value as AppSettings['latencyMode'] })}><option value="interactive">低延迟</option><option value="balanced">平衡</option><option value="playback">稳定播放</option></select></label></div></section>
    <section className="settings-section"><h3><FolderOpen />存储位置</h3><label className="path-field">数据目录<div className="path-picker"><input readOnly value={dataRoot} title={dataRoot} /><button className="outline-button" type="button" onClick={() => void chooseDataRoot()}><FolderOpen size={15} />浏览</button></div></label><p className="security-note">歌曲、运行环境和模型将分别保存在 music、envs 和 envs/models 子目录中。</p></section>
    <section className="settings-section"><h3><ShieldCheck />高级网络</h3><div className="settings-grid"><label>代理<select value={draft.network.proxyMode} onChange={(event) => setDraft({ ...draft, network: { ...draft.network, proxyMode: event.target.value as AppSettings['network']['proxyMode'] } })}><option value="system">使用系统代理</option><option value="manual">手动代理</option><option value="none">不使用代理</option></select></label>{draft.network.proxyMode === 'manual' && <label>代理地址<input type="password" autoComplete="off" value={draft.network.proxyUrl} onChange={(event) => setDraft({ ...draft, network: { ...draft.network, proxyUrl: event.target.value } })} placeholder="https://user:password@host:port" /></label>}</div><label>Python HTTPS 镜像<input value={draft.network.pythonIndexUrl} onChange={(event) => setDraft({ ...draft, network: { ...draft.network, pythonIndexUrl: event.target.value } })} /></label><p className="security-note"><ShieldCheck size={13} />模型从 Demucs 官方 CDN 下载；代理凭据不会写入日志，权重会校验 SHA-256。</p></section>
    </div>
    <footer className="drawer-footer sticky"><Dialog.Close className="outline-button">取消</Dialog.Close><button className="primary-button" onClick={() => void window.bandbuddy.settings.update(draft).then((saved) => { onSaved(saved); onOpenChange(false) })}>保存设置</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function ExportDialog({ open, onOpenChange, song, practice, onBeforeStart }: { open: boolean; onOpenChange(open: boolean): void; song: SongDetail; practice: PracticeState; onBeforeStart(): Promise<void> }): React.JSX.Element {
  const [kind, setKind] = useState<'stems' | 'mix'>('mix')
  const [format, setFormat] = useState<ExportFormat>('flac')
  const available = useMemo(() => song.stems.map((stem) => stem.type), [song])
  const [selected, setSelected] = useState<StemType[]>(available)
  const [applyRate, setApplyRate] = useState(false)
  const [applyLoop, setApplyLoop] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { if (open) { setSelected(available); setMessage('') } }, [open, available])
  const start = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      await onBeforeStart()
      const outputPath = await window.bandbuddy.export.choosePath(kind, format, song.title)
      if (!outputPath) return
      const result = await window.bandbuddy.export.start({
        songId: song.id, kind, format, stemTypes: selected, outputPath,
        applyPlaybackRate: kind === 'mix' && applyRate, playbackRate: practice.playbackRate,
        applyLoopRange: kind === 'mix' && applyLoop, loopStartMs: practice.loopStartMs, loopEndMs: practice.loopEndMs,
        overwriteMode: 'ask'
      })
      setMessage(`已加入任务队列 · ${result.outputPaths.length} 个文件`)
    } catch (error) { setMessage(String(error).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="dialog-content export-dialog" data-dialog-open="true" aria-describedby={undefined}>
    <Dialog.Title>导出音频</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close><p className="dialog-lead">分轨导出保持标准音量；当前混音会应用练习室的 Mute、Solo 与增益。</p>
    <div className="dialog-tabs"><button className={kind === 'mix' ? 'active' : ''} onClick={() => setKind('mix')}><SlidersHorizontal />导出当前混音</button><button className={kind === 'stems' ? 'active' : ''} onClick={() => setKind('stems')}><FileAudio />分别导出音轨</button></div>
    <fieldset><legend>选择音轨</legend><div className="export-stems">{available.map((type) => <label key={type} style={{ '--track': STEM_META[type].color } as React.CSSProperties}><input type="checkbox" checked={selected.includes(type)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, type] : current.filter((item) => item !== type))} /><i /><span>{STEM_META[type].shortLabel}<small>{STEM_META[type].label}</small></span></label>)}</div></fieldset>
    <fieldset><legend>输出格式</legend><div className="format-options">{(['wav', 'flac', 'mp3'] as const).map((item) => <button className={format === item ? 'active' : ''} onClick={() => setFormat(item)} key={item}><b>{item.toUpperCase()}</b><small>{item === 'mp3' ? '320 kbps' : '44.1 kHz · 24-bit'}</small></button>)}</div></fieldset>
    {kind === 'mix' && <fieldset><legend>混音范围</legend><label className="check-line"><input type="checkbox" checked={applyRate} onChange={(event) => setApplyRate(event.target.checked)} /><span>应用当前速度 <small>{practice.playbackRate.toFixed(1)}×，保持音高</small></span></label><label className="check-line"><input type="checkbox" disabled={practice.loopStartMs === null || practice.loopEndMs === null} checked={applyLoop} onChange={(event) => setApplyLoop(event.target.checked)} /><span>仅导出当前 A–B <small>默认导出整首歌曲</small></span></label></fieldset>}
    {message && <p className="export-message"><Check />{message}</p>}<footer className="dialog-footer"><Dialog.Close className="outline-button">关闭</Dialog.Close><button className="primary-button" disabled={busy || selected.length === 0} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" /> : <Upload />}选择位置并导出</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function MetadataDialog({ open, onOpenChange, song, onSaved }: { open: boolean; onOpenChange(open: boolean): void; song: SongDetail; onSaved(song: SongDetail): void }): React.JSX.Element {
  const [title, setTitle] = useState(song.title), [artist, setArtist] = useState(song.artist)
  const [bpm, setBpm] = useState(song.bpm?.toString() ?? ''), [key, setKey] = useState(song.musicalKey ?? ''), [time, setTime] = useState(song.timeSignature ?? '')
  useEffect(() => { setTitle(song.title); setArtist(song.artist); setBpm(song.bpm?.toString() ?? ''); setKey(song.musicalKey ?? ''); setTime(song.timeSignature ?? '') }, [song, open])
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="dialog-content metadata-dialog" data-dialog-open="true" aria-describedby={undefined}><Dialog.Title>编辑歌曲信息</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close><div className="form-stack"><label>歌曲标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>艺术家<input value={artist} onChange={(event) => setArtist(event.target.value)} /></label><div className="form-row"><label>BPM（可修改）<input type="number" min="20" max="400" value={bpm} onChange={(event) => setBpm(event.target.value)} /></label><label>调号<input placeholder="例如 Em" value={key} onChange={(event) => setKey(event.target.value)} /></label><label>拍号<input placeholder="例如 4/4" value={time} onChange={(event) => setTime(event.target.value)} /></label></div></div><p className="security-note">BPM 可在练习室的节拍器中检测，也可以在这里手动修改。</p><footer className="dialog-footer"><Dialog.Close className="outline-button">取消</Dialog.Close><button className="primary-button" onClick={() => void window.bandbuddy.library.update({ id: song.id, patch: { title, artist, bpm: bpm ? Number(bpm) : null, musicalKey: key || null, timeSignature: time || null } }).then((saved) => { onSaved(saved); onOpenChange(false) })}>保存</button></footer></Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function SongActionsDialog({
  open, onOpenChange, song, onOpen, onReveal, onReseparate, onDelete
}: {
  open: boolean
  onOpenChange(open: boolean): void
  song: SongSummary | null
  onOpen(): void
  onReveal(): void
  onReseparate(): void
  onDelete(): void
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { if (open) setConfirmDelete(false) }, [open, song?.id])
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="dialog-content song-actions-dialog" data-dialog-open="true" aria-describedby={undefined}>
    <Dialog.Title>{song?.title ?? '歌曲操作'}</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close>
    <p className="dialog-lead">管理本地曲目、原始文件与分离版本。</p>
    <div className="song-action-list">
      <button onClick={() => { onOpenChange(false); onOpen() }}><FileAudio /><span><b>打开练习室</b><small>继续当前保存的混音与循环设置</small></span></button>
      <button onClick={() => { onOpenChange(false); onReveal() }}><FolderOpen /><span><b>在资源管理器中显示</b><small>打开 UUID 管理目录，不暴露给网页内容</small></span></button>
      <button disabled={song?.status !== 'ready'} onClick={() => { onOpenChange(false); onReseparate() }}><RefreshCw /><span><b>重新分轨</b><small>成功前继续使用当前分轨版本</small></span></button>
      <button className="danger" onClick={() => setConfirmDelete(true)}><Trash2 /><span><b>删除歌曲</b><small>受管目录会移入 Windows 回收站</small></span></button>
    </div>
    {confirmDelete && <div className="inline-warning danger"><AlertTriangle /><span><b>确认删除“{song?.title}”？</b><small>播放会停止，相关任务会取消；文件可从回收站恢复。</small></span><button onClick={() => { onOpenChange(false); onDelete() }}>确认删除</button><button onClick={() => setConfirmDelete(false)}>取消</button></div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
