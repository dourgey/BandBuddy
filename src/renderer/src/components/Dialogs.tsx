import { LanSettings } from './LanSettings.js'
import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertTriangle,
  AudioLines,
  Bug,
  Check,
  ChevronRight,
  Download,
  FileAudio,
  FileText,
  FolderOpen,
  Gauge,
  HardDrive,
  LoaderCircle,
  Pencil,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  MUSICAL_KEY_TONICS,
  STEM_META,
  STEM_ORDER,
  formatMusicalKey,
  isStemVisible,
  parseMusicalKey,
  type AppSettings,
  type AudioBackend,
  type ExportFormat,
  type GuitarSeparationQuality,
  type JobRecord,
  type MusicalKeyAnalysis,
  type MusicalKeyMode,
  type MusicalKeySource,
  type MusicalKeyTonic,
  type PracticeState,
  type RecordingDeviceInfo,
  type RecordingState,
  type RuntimeInfo,
  type SongDetail,
  type SongSummary,
  type StemType
} from '@shared/domain.js'
import { SOURCE_MEDIA_EXTENSIONS } from '@shared/media-formats.js'
import { applyRuntimeSourcePreset, matchRuntimeSourcePreset, type RuntimeSourcePreset } from '@shared/runtime-sources.js'
import { formatDate, formatTime, isCancellationError, statusLabel, toUserErrorMessage } from '../utils.js'

const GUITAR_QUALITY_VALUES: readonly GuitarSeparationQuality[] = ['fast', 'balanced', 'high']
const GUITAR_QUALITY_DETAILS: Record<GuitarSeparationQuality, { label: string; detail: string }> = {
  fast: {
    label: '极速',
    detail: '两套 MDX-Net + HTDemucs；快速/预览质量。本次 RTX 3060 测试曲目约 27 秒。'
  },
  balanced: {
    label: '平衡',
    detail: '共享 BS-RoFormer 主干 · HQ3；兼顾分轨效果与等待时间。'
  },
  high: {
    label: '高质量',
    detail: '共享 BS-RoFormer 主干 · HQ6；效果优先，用时最长。'
  }
}

export function ImportDialog({
  open,
  onOpenChange,
  onImported,
  onOpenDuplicate,
  onNeedsRuntime
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onImported(songId: string): void
  onOpenDuplicate(songId: string): void
  onNeedsRuntime(): void
}): React.JSX.Element {
  const [mode, setMode] = useState<'source' | 'stems'>('source')
  const [stemFiles, setStemFiles] = useState<Array<{ path: string; type: StemType; name: string }>>([])
  const [padding, setPadding] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [source, setSource] = useState<{ path: string; name: string } | null>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [duplicate, setDuplicate] = useState<{ id: string; title: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('source'); setStemFiles([]); setPadding(null)
    setSource(null); setTitle(''); setArtist('')
    setError(''); setDuplicate(null); setDragging(false)
  }, [open])

  const chooseStems = async (mode: 'files' | 'folder' = 'files'): Promise<void> => {
    try {
      const choices = await window.bandbuddy.library.chooseStems(mode)
      if (!choices.length) return
      if (choices.length > STEM_ORDER.length) { setError('每次最多导入 9 条音轨'); return }
      const used = new Set<StemType>()
      const files = choices.map((choice) => {
        const inferred = STEM_ORDER.find((type) => !used.has(type) && (choice.inferredTitle.toLowerCase().includes(type) || choice.inferredTitle.includes(STEM_META[type].label)))
        const type = inferred ?? STEM_ORDER.find((candidate) => !used.has(candidate))!
        used.add(type)
        return { path: choice.path, type, name: inferred ? STEM_META[type].label : choice.inferredTitle }
      })
      setStemFiles(files); setPadding(null); setError('')
    } catch (reason) { setError(toUserErrorMessage(reason, '无法选择分轨文件')) }
  }

  const chooseSource = async (): Promise<void> => {
    if (busy) return
    try {
      const choice = await window.bandbuddy.library.chooseSource()
      if (!choice) return
      setSource(choice)
      setError(''); setDuplicate(null)
      if (!title || title === source?.name.replace(/\.[^.]+$/, '')) setTitle(choice.inferredTitle)
    } catch (reason) { setError(toUserErrorMessage(reason, '无法选择文件')) }
  }

  const dropSource = (event: React.DragEvent): void => {
    event.preventDefault(); event.stopPropagation(); setDragging(false)
    if (busy) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length !== 1) { setError('请每次拖入一个音频或视频文件'); return }
    const file = files[0]!
    if (!SOURCE_MEDIA_EXTENSIONS.has(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())) {
      setError('不支持此文件格式，请拖入音频或视频文件'); return
    }
    try {
      const path = window.bandbuddy.library.getPathForFile(file)
      if (!path) throw new Error('无法读取文件路径，请使用点击选择文件')
      setSource({ path, name: file.name })
      if (!title || title === source?.name.replace(/\.[^.]+$/, '')) setTitle(file.name.replace(/\.[^.]+$/, ''))
      setError(''); setDuplicate(null)
    } catch (reason) { setError(toUserErrorMessage(reason, '无法读取拖入的文件')) }
  }

  const submit = async (forceDuplicate = false, padMismatched = false): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (mode === 'source' && !source) throw new Error('请先选择一首歌曲')
      const result = mode === 'stems'
        ? await window.bandbuddy.library.importStems({ files: stemFiles, title, artist, padMismatched })
        : await window.bandbuddy.library.importSource({ filePath: source!.path, title, artist, forceDuplicate })
      if (result.needsPadding) { setPadding(result.durationDifferenceMs ?? 0); return }
      if (result.duplicate) { setDuplicate({ id: result.duplicate.id, title: result.duplicate.title }); return }
      if (result.songId) {
        onOpenChange(false); onImported(result.songId); if (mode === 'source') onNeedsRuntime()
      }
    } catch (reason) {
      setError(toUserErrorMessage(reason, '导入失败，请检查音频或视频文件后重试'))
    } finally { setBusy(false) }
  }

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" data-dialog-open="true" />
      <Dialog.Content className="dialog-content import-dialog" data-dialog-open="true" aria-describedby={undefined}>
        <Dialog.Title>导入音乐</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close>
        <p className="dialog-lead">源文件会复制到受管曲库。视频会先提取音频再分轨，所有处理均在本机完成。</p>
        <div className="dialog-tabs"><button disabled={busy} className={mode === 'source' ? 'active' : ''} onClick={() => { setMode('source'); setError(''); setPadding(null) }}>歌曲 / 视频</button><button disabled={busy} className={mode === 'stems' ? 'active' : ''} onClick={() => { setMode('stems'); setError(''); setDuplicate(null) }}>已分轨数据</button></div>
        {mode === 'stems' ? <div className="stem-import"><button disabled={busy} className="outline-button" onClick={() => void chooseStems()}><FolderOpen size={16} />选择分轨文件</button> <button disabled={busy} className="outline-button" onClick={() => void chooseStems('folder')}><FolderOpen size={16} />选择文件夹</button><p>导入 2–9 条音轨，无需安装分离模型。选择预设名称或输入自定义名称。各轨从同一时间点开始，较短音轨将在末尾补静音。</p>
          {stemFiles.map((file, index) => <div className="stem-import-row" key={file.path}><small title={file.path}>{file.path.split(/[\\/]/).pop()}</small><select disabled={busy} aria-label={`轨道 ${index + 1} 预设名称`} value={STEM_ORDER.find((type) => STEM_META[type].label === file.name) ?? 'custom'} onChange={(event) => {
            const value = event.target.value
            setStemFiles((current) => current.map((item, position) => position === index ? { ...item, name: value === 'custom' ? '' : STEM_META[value as StemType].label } : item)); setPadding(null)
          }}><option value="custom">自定义名称</option>{STEM_ORDER.map((type) => <option value={type} key={type}>{STEM_META[type].label}</option>)}</select><input disabled={busy} aria-label={`轨道 ${index + 1} 名称`} maxLength={80} value={file.name} placeholder="输入轨道名称" onChange={(event) => { setStemFiles((current) => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item)); setPadding(null) }} /></div>)}
        </div> : <div className={`drop-zone ${source ? 'selected' : ''} ${dragging ? 'is-dragging' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy}
          onClick={() => void chooseSource()}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void chooseSource() } }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; if (!busy) setDragging(true) }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
          onDrop={dropSource}>
          <span>{source ? <Check size={25} /> : <Upload size={25} />}</span><b>{source?.name ?? '选择音频或视频文件'}</b><small>{source ? '点击重新选择，或拖入文件替换' : '可直接拖入文件 · 音频：MP3 / WAV / FLAC / M4A / AAC / OGG / OPUS / AIFF / WMA 等 · 视频：MP4 / MOV / MKV / WebM / AVI / WMV / FLV / TS 等'}</small>
        </div>}
        <div className="form-row"><label>歌曲标题<input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可选，默认使用文件名" /></label><label>艺术家<input maxLength={200} value={artist} onChange={(event) => setArtist(event.target.value)} placeholder="可选" /></label></div>
        {duplicate && <div className="inline-warning"><AlertTriangle /><span><b>曲库已有“{duplicate.title}”</b><small>可打开已有歌曲，或仍然创建一份副本。</small></span><button onClick={() => { onOpenChange(false); onOpenDuplicate(duplicate.id) }}>打开已有</button><button onClick={() => void submit(true)}>仍创建副本</button></div>}
        {padding !== null && <div className="inline-warning"><span>各轨时长相差 {(padding / 1000).toFixed(1)} 秒。保持起点不变，在短轨末尾补静音后导入。</span><button disabled={busy} onClick={() => void submit(false, true)}>补静音并导入</button></div>}
        {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
        <footer className="dialog-footer"><Dialog.Close className="outline-button">取消</Dialog.Close><button className="primary-button" disabled={busy || (mode === 'source' ? !source : stemFiles.length < 2 || stemFiles.some((file) => !file.name.trim()))} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={17} />}导入并处理</button></footer>
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
      <header><span className={`task-dot ${job.status}`} /> <b>{job.type === 'separate' ? '基础分轨' : job.type === 'guitarSplit' ? '吉他细分轨' : job.type === 'normalizeStems' ? '分轨标准化' : job.type === 'export' ? '音频导出' : '环境安装'}</b><em>{statusLabel(job.status)}</em></header>
      <p>{job.phase}</p><div className="progress-line"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div><small>{Math.round(job.progress * 100)}% · {formatDate(job.createdAt)}</small>
      {job.errorMessage && job.status !== 'cancelled' && <pre>{toUserErrorMessage(`${job.errorCode ?? ''} ${job.errorMessage}`, '任务执行失败，请重试')}</pre>}
      <footer>{['queued', 'blockedRuntime', 'preparing', 'separating', 'postprocessing'].includes(job.status) && <button onClick={() => void window.bandbuddy.tasks.cancel(job.id).then(onRefresh)}>取消</button>}{['failed', 'cancelled', 'interrupted'].includes(job.status) && <><button onClick={() => void window.bandbuddy.tasks.retry(job.id).then(onRefresh)}>重试</button>{['ACCELERATOR_OOM', 'CUDA_OOM'].includes(job.errorCode ?? '') && <button onClick={() => void window.bandbuddy.tasks.retry(job.id, true).then(onRefresh)}>使用 CPU 重试</button>}</>}</footer>
    </article>)}</div>
    <footer className="drawer-footer"><button className="outline-button" onClick={() => void window.bandbuddy.tasks.clearFinished().then(onRefresh)}><Trash2 size={16} />清除已完成</button><button className="outline-button" onClick={onRefresh}><RefreshCw size={16} />刷新</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

type SettingsCategory = 'separation' | 'audio' | 'general' | 'network' | 'storage'

function SettingsGroup({ title, description, summary, icon, open, onOpenChange, onSave, saving, error, children }: {
  title: string
  description: string
  summary: string
  icon: ReactNode
  open: boolean
  onOpenChange(open: boolean): void
  onSave(): void
  saving: boolean
  error: string
  children: ReactNode
}): React.JSX.Element {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger className="settings-category" aria-label={title}>
      <span className="settings-category-icon">{icon}</span>
      <span className="settings-category-copy"><b>{title}</b><small>{description}</small><em>{summary}</em></span>
      <ChevronRight size={18} />
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay settings-detail-overlay" data-dialog-open="true" />
      <Dialog.Content className="dialog-content settings-detail" data-dialog-open="true">
        <header className="settings-detail-header"><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></header>
        <Dialog.Close className="dialog-close" aria-label="返回设置分类"><X /></Dialog.Close>
        <div className="settings-detail-scroll">{children}</div>
        <footer className="settings-detail-footer">
          {error && <p className="form-error" role="alert">{error}</p>}
          <span>修改暂存，保存后生效；即时操作另有标注。</span>
          <div><Dialog.Close className="outline-button">返回分类</Dialog.Close><button className="primary-button" disabled={saving} onClick={onSave}>{saving ? '正在保存…' : '保存设置'}</button></div>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
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
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [busy, setBusy] = useState(false)
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [recordingDevices, setRecordingDevices] = useState<RecordingDeviceInfo[]>([])
  const [recordingDeviceError, setRecordingDeviceError] = useState('')
  const [testingInput, setTestingInput] = useState(false)
  const [startingInputTest, setStartingInputTest] = useState(false)
  const [testState, setTestState] = useState<RecordingState | null>(null)
  const [testPeak, setTestPeak] = useState(0)
  const [debugModeSaving, setDebugModeSaving] = useState(false)
  const [debugLogError, setDebugLogError] = useState('')
  const inputTestRequested = useRef(false)
  useEffect(() => {
    if (!open) { setDraft(settings); setActiveCategory(null); setSaveError(''); setConfirmInstall(false) }
  }, [settings, open])
  useEffect(() => { if (open) setDebugLogError('') }, [open])
  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return
    void navigator.mediaDevices.enumerateDevices().then((devices) => setAudioOutputs(devices.filter((device) => device.kind === 'audiooutput'))).catch(() => setAudioOutputs([]))
  }, [open])
  useEffect(() => {
    if (!open) return
    setRecordingDeviceError('')
    void window.bandbuddy.recording.devices().then(setRecordingDevices).catch((error) => setRecordingDeviceError(toUserErrorMessage(error, '无法读取音频设备，请检查声卡后重试')))
    const unsubscribeState = window.bandbuddy.recording.onState((state) => {
      setTestState(state)
      setTestingInput(state.phase === 'testing')
    })
    const unsubscribeMeter = window.bandbuddy.recording.onMeter((meter) => setTestPeak(Math.max(...meter.peak, 0)))
    return () => { unsubscribeState(); unsubscribeMeter() }
  }, [open])
  useEffect(() => {
    if ((!open || activeCategory !== 'audio') && inputTestRequested.current) {
      inputTestRequested.current = false
      setTestingInput(false)
      setTestState(null)
      void window.bandbuddy.recording.stopTest().catch(() => undefined)
    }
  }, [open, activeCategory])
  const changing = ['installing', 'downloadingModel', 'verifying', 'detecting'].includes(runtime.status)
  const action = async (operation: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await operation(); onRefresh() } finally { setBusy(false) } }
  const dataRoot = draft.libraryRoot.replace(/[\\/]+music$/i, '')
  const chooseDataRoot = async (): Promise<void> => {
    const selected = await window.bandbuddy.settings.chooseDataRoot(draft.libraryRoot)
    if (!selected) return
    setDraft({ ...draft, libraryRoot: selected.libraryRoot, runtimeRoot: selected.runtimeRoot, modelRoot: selected.modelRoot })
  }
  const toggleDebugMode = async (enabled: boolean): Promise<void> => {
    const previous = draft.debugMode
    setDraft((current) => ({ ...current, debugMode: enabled }))
    setDebugModeSaving(true)
    setDebugLogError('')
    try {
      const saved = await window.bandbuddy.settings.setDebugMode(enabled)
      onSaved(saved)
    } catch (error) {
      setDraft((current) => ({ ...current, debugMode: previous }))
      setDebugLogError(toUserErrorMessage(error, '无法切换 Debug 模式，请稍后重试'))
    } finally {
      setDebugModeSaving(false)
    }
  }
  const revealDebugLog = async (): Promise<void> => {
    setDebugLogError('')
    try { await window.bandbuddy.settings.revealDebugLog() }
    catch (error) { setDebugLogError(toUserErrorMessage(error, '无法打开 debug.log 所在位置，请稍后重试')) }
  }
  const automaticBackend: Exclude<AudioBackend, 'auto'> = /Mac/i.test(navigator.platform) ? 'coreaudio' : 'wasapi-shared'
  const selectedBackend = draft.recordingAudio.backend === 'auto' ? automaticBackend : draft.recordingAudio.backend
  const alignmentKey = `${selectedBackend}|${draft.recordingAudio.inputDeviceId || 'default'}|${draft.recordingAudio.outputDeviceId || 'default'}`
  const backendDevices = recordingDevices.filter((device) => device.backend === selectedBackend)
  const inputDevices = backendDevices.filter((device) => device.inputChannels > 0)
  const outputDevices = backendDevices.filter((device) => device.outputChannels > 0)
  const selectedInput = inputDevices.find((device) => device.id === draft.recordingAudio.inputDeviceId)
    ?? inputDevices.find((device) => device.defaultInput)
    ?? inputDevices[0]
  const inputChannelCount = selectedInput?.inputChannels ?? Math.max(1, ...inputDevices.map((device) => device.inputChannels))
  const patchRecording = (patch: Partial<AppSettings['recordingAudio']>): void => setDraft({ ...draft, recordingAudio: { ...draft.recordingAudio, ...patch } })
  const patchNetwork = (patch: Partial<AppSettings['network']>): void => {
    setDraft((current) => ({ ...current, network: { ...current.network, ...patch } }))
  }
  const runtimeSourcePreset = matchRuntimeSourcePreset(draft.network) ?? 'custom'
  const selectRuntimeSourcePreset = (preset: RuntimeSourcePreset): void => {
    setDraft((current) => ({ ...current, network: applyRuntimeSourcePreset(current.network, preset) }))
  }
  const toggleInputTest = async (): Promise<void> => {
    if (testingInput) {
      inputTestRequested.current = false
      await window.bandbuddy.recording.stopTest()
      setTestingInput(false)
      return
    }
    setRecordingDeviceError('')
    setStartingInputTest(true)
    inputTestRequested.current = true
    try {
      const saved = await window.bandbuddy.settings.update(draft)
      onSaved(saved)
      if (!inputTestRequested.current) return
      await window.bandbuddy.recording.startTest()
      if (!inputTestRequested.current) {
        await window.bandbuddy.recording.stopTest()
        return
      }
      setTestingInput(true)
    } catch (error) {
      inputTestRequested.current = false
      setRecordingDeviceError(toUserErrorMessage(error, '输入测试失败，请检查声卡后重试'))
    } finally { setStartingInputTest(false) }
  }
  const saveSettings = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    try {
      const saved = await window.bandbuddy.settings.update(draft)
      onSaved(saved)
      setActiveCategory(null)
      onOpenChange(false)
    } catch (error) {
      setSaveError(toUserErrorMessage(error, '设置保存失败，请重试'))
    } finally { setSaving(false) }
  }
  const groupProps = (category: SettingsCategory) => ({
    open: open && activeCategory === category,
    onOpenChange: (next: boolean) => setActiveCategory(next ? category : null),
    onSave: () => { void saveSettings() },
    saving: saving || debugModeSaving,
    error: saveError
  })
  const guitarQualityIndex = GUITAR_QUALITY_VALUES.indexOf(draft.guitarSeparationQuality)
  const guitarQuality = GUITAR_QUALITY_DETAILS[draft.guitarSeparationQuality]
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="drawer settings-drawer" data-dialog-open="true" aria-describedby={undefined} onEscapeKeyDown={(event) => {
    if (activeCategory) { event.preventDefault(); setActiveCategory(null) }
  }}>
    <Dialog.Close className="dialog-close" aria-label="关闭设置"><X /></Dialog.Close><div className="settings-scroll">
    <Dialog.Title>设置</Dialog.Title><p className="dialog-lead">按用途整理偏好，让练习保持顺手。</p>
    <div className="settings-categories">
    <SettingsGroup title="分轨与运行环境" description="分轨音质、计算设备与本地环境" summary={`${guitarQuality.label} · ${draft.highQualityStems ? 'FLAC' : 'MP3'} · ${statusLabel(runtime.status)}`} icon={<Zap />} {...groupProps('separation')}>
    <section className="settings-section"><h3><HardDrive />分轨音质</h3>
      <div className="guitar-quality-setting">
        <header><span><b>吉他分轨档位</b><small>仅影响后续新建的吉他分轨任务</small></span><strong>{guitarQuality.label}</strong></header>
        <input
          type="range"
          min="0"
          max="2"
          step="1"
          value={Math.max(0, guitarQualityIndex)}
          aria-label="吉他分轨档位"
          aria-valuetext={guitarQuality.label}
          onChange={(event) => {
            const next = GUITAR_QUALITY_VALUES[Number(event.currentTarget.value)] ?? 'balanced'
            setDraft((current) => ({ ...current, guitarSeparationQuality: next }))
          }}
        />
        <div className="guitar-quality-labels" aria-hidden="true"><span>极速</span><span>平衡</span><span>高质量</span></div>
        <p>{guitarQuality.detail}</p>
      </div>
      <label className="settings-toggle"><input type="checkbox" aria-label="高音质分轨" checked={draft.highQualityStems} onChange={(event) => setDraft({ ...draft, highQualityStems: event.target.checked })} /><span><b>高音质分轨</b><small>{draft.highQualityStems ? '新分轨保存为 24-bit FLAC，占用空间较大' : '新分轨保存为 320 kbps MP3，节省空间'}</small></span></label>
      <p className="security-note">仅影响后续分轨；已有歌曲需重新分轨才会改变格式</p>
    </section>
    <section className="settings-section"><h3><Zap />本地分离环境</h3>
      <div className={`runtime-card ${runtime.status}`}><header><span><i /><b>{statusLabel(runtime.status)}</b></span><em>{runtime.selectedDevice.toUpperCase()}</em></header><p>{runtime.stage}</p>{runtime.progress !== null && <div className="progress-line"><i style={{ width: `${runtime.progress * 100}%` }} /></div>}{runtime.error && <pre>{toUserErrorMessage(runtime.error, '运行环境异常，请尝试修复或重新安装')}</pre>}
        <dl>{runtime.windowsVcRuntimeVersion && <div><dt>VC++</dt><dd>{runtime.windowsVcRuntimeVersion}</dd></div>}<div><dt>Python</dt><dd>{runtime.pythonVersion ?? '—'}</dd></div><div><dt>PyTorch</dt><dd>{runtime.torchVersion ?? '—'}</dd></div><div><dt>CUDA</dt><dd>{runtime.cudaVersion ?? '—'}</dd></div></dl>
      </div>
      {runtime.gpu ? <div className="gpu-card"><Gauge /><span><b>{runtime.gpu.name}</b><small>驱动 {runtime.gpu.driverVersion} · {Math.round(runtime.gpu.memoryMb / 1024)} GB 显存</small></span></div> : <div className="gpu-card muted"><Gauge /><span><b>{runtime.selectedDevice === 'mps' ? 'Apple MPS 加速' : '未检测到 NVIDIA GPU'}</b><small>{runtime.selectedDevice === 'mps' ? '将使用 Apple 芯片 GPU；不可用时自动切换 CPU。' : '将自动使用 CPU 完成本地分轨。'}</small></span></div>}
      <div className="runtime-actions">{changing ? <button className="outline-button" onClick={() => void window.bandbuddy.runtime.cancel()}>取消当前操作</button> : runtime.status === 'ready' ? <><button className="outline-button" onClick={() => void action(() => window.bandbuddy.runtime.detect())}>重新检测</button><button className="outline-button" onClick={() => void action(() => window.bandbuddy.runtime.repair())}>修复环境</button></> : <button className="primary-button" onClick={() => setConfirmInstall(true)}><Download size={17} />安装本地环境</button>}</div>
      {confirmInstall && <div className="install-confirm"><HardDrive /><span><b>预计需要 8–15 GB 可用空间</b><small>会下载私有 CPython、Torch 和分轨资源；Windows 缺少 VC++ 运行库时会从微软下载并请求系统授权。</small></span><button className="primary-button small" disabled={busy} onClick={() => { setConfirmInstall(false); void action(() => window.bandbuddy.runtime.install()) }}>确认安装</button><button onClick={() => setConfirmInstall(false)}>稍后</button></div>}
      <div className="danger-actions"><button onClick={() => void action(() => window.bandbuddy.runtime.clearModel())}>清理分轨资源缓存</button><button onClick={() => void action(() => window.bandbuddy.runtime.remove(false))}>卸载环境</button><button onClick={() => void action(() => window.bandbuddy.runtime.remove(true))}>环境与分轨资源全部清理</button></div>
      <div className="settings-grid"><label>首选计算设备<select value={draft.preferredDevice} onChange={(event) => setDraft({ ...draft, preferredDevice: event.target.value as AppSettings['preferredDevice'] })}><option value="auto">自动：CUDA → MPS → CPU</option><option value="cuda">NVIDIA CUDA（不可用时回退）</option><option value="mps">Apple MPS（不可用时回退）</option><option value="cpu">CPU</option></select></label></div>
    </section>
    </SettingsGroup>
    <SettingsGroup title="音频与录音" description="播放输出、录音设备、延迟与输入测试" summary={`${draft.latencyMode === 'interactive' ? '低延迟' : draft.latencyMode === 'balanced' ? '平衡延迟' : '稳定播放'} · ${draft.recordingAudio.inputChannelMode === 'mono' ? '单声道输入' : '立体声输入'}`} icon={<AudioLines />} {...groupProps('audio')}>
    <section className="settings-section"><h3><SlidersHorizontal />音频播放</h3><div className="settings-grid"><label>音频输出<select value={draft.audioOutputDeviceId} onChange={(event) => setDraft({ ...draft, audioOutputDeviceId: event.target.value })}><option value="">系统默认输出</option>{audioOutputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `音频输出 ${index + 1}`}</option>)}</select></label><label>延迟模式<select value={draft.latencyMode} onChange={(event) => setDraft({ ...draft, latencyMode: event.target.value as AppSettings['latencyMode'] })}><option value="interactive">低延迟</option><option value="balanced">平衡</option><option value="playback">稳定播放</option></select></label></div></section>
    <section className="settings-section recording-device-settings"><h3><AudioLines />练习录音设备</h3>
      <p className="security-note">如需监听自己的输入，请使用声卡或调音台的硬件直通监听。</p>
      <div className="settings-grid">
        <label>音频后端<select value={draft.recordingAudio.backend} onChange={(event) => patchRecording({ backend: event.target.value as AudioBackend, inputDeviceId: '', outputDeviceId: '', inputChannels: draft.recordingAudio.inputChannelMode === 'mono' ? [0] : [0, 1] })}><option value="auto">自动（系统默认）</option>{recordingDevices.some((device) => device.backend === 'asio') && <option value="asio">ASIO</option>}{recordingDevices.some((device) => device.backend === 'wasapi-shared') && <option value="wasapi-shared">WASAPI Shared</option>}{recordingDevices.some((device) => device.backend === 'wasapi-exclusive') && <option value="wasapi-exclusive">WASAPI Exclusive</option>}{recordingDevices.some((device) => device.backend === 'coreaudio') && <option value="coreaudio">CoreAudio</option>}</select></label>
        <label>输入设备<select value={draft.recordingAudio.inputDeviceId} onChange={(event) => patchRecording({ inputDeviceId: event.target.value, inputChannels: draft.recordingAudio.inputChannelMode === 'mono' ? [0] : [0, 1] })}><option value="">默认输入</option>{inputDevices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.inputChannels} in</option>)}</select></label>
        <label>输出设备<select value={draft.recordingAudio.outputDeviceId} onChange={(event) => patchRecording({ outputDeviceId: event.target.value })}><option value="">默认输出</option>{outputDevices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.outputChannels} out</option>)}</select></label>
        <label>输入模式<select value={draft.recordingAudio.inputChannelMode} onChange={(event) => patchRecording({ inputChannelMode: event.target.value as 'mono' | 'stereo', inputChannels: event.target.value === 'mono' ? [0] : [0, 1] })}><option value="mono">单声道</option><option value="stereo" disabled={inputChannelCount < 2}>立体声通道对</option></select></label>
        <label>{draft.recordingAudio.inputChannelMode === 'mono' ? '输入通道' : '起始通道'}<select value={draft.recordingAudio.inputChannels[0] ?? 0} onChange={(event) => { const channel = Number(event.target.value); patchRecording({ inputChannels: draft.recordingAudio.inputChannelMode === 'mono' ? [channel] : [channel, channel + 1] }) }}>{Array.from({ length: Math.max(1, inputChannelCount - (draft.recordingAudio.inputChannelMode === 'stereo' ? 1 : 0)) }, (_, channel) => <option key={channel} value={channel}>{draft.recordingAudio.inputChannelMode === 'mono' ? `Input ${channel + 1}` : `Input ${channel + 1}–${channel + 2}`}</option>)}</select></label>
        <label>采样率<select value={draft.recordingAudio.sampleRate} onChange={(event) => patchRecording({ sampleRate: Number(event.target.value) })}><option value="0">Auto</option><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option><option value="88200">88.2 kHz</option><option value="96000">96 kHz</option></select></label>
        <label>Buffer frames<select value={draft.recordingAudio.bufferFrames} onChange={(event) => patchRecording({ bufferFrames: Number(event.target.value) })}><option value="0">Auto</option>{[32, 64, 128, 256, 512, 1024].map((frames) => <option key={frames} value={frames}>{frames}</option>)}</select></label>
        <label>设备对齐偏移（ms）<input type="number" min="-1000" max="1000" step="1" value={draft.recordingAudio.deviceAlignmentOffsets[alignmentKey] ?? draft.recordingAudio.alignmentOffsetMs} onChange={(event) => { const alignmentOffsetMs = Number(event.target.value); patchRecording({ alignmentOffsetMs, deviceAlignmentOffsets: { ...draft.recordingAudio.deviceAlignmentOffsets, [alignmentKey]: alignmentOffsetMs } }) }} /></label>
      </div>
      <div className="runtime-actions"><button className="outline-button" type="button" onClick={() => void window.bandbuddy.recording.devices().then(setRecordingDevices).catch((error) => setRecordingDeviceError(toUserErrorMessage(error, '无法读取音频设备，请检查声卡后重试')))}><RefreshCw size={15} />刷新设备</button><button className={testingInput ? 'primary-button' : 'outline-button'} type="button" disabled={startingInputTest} onClick={() => void toggleInputTest()}>{startingInputTest ? '正在启动测试…' : testingInput ? '停止输入测试' : '保存并测试输入'}</button></div>
      {testState && ['testing', 'recording', 'countIn'].includes(testState.phase) && <><p className="device-runtime-stats">{testState.sampleRate} Hz · {testState.bufferFrames} frames · 约 {testState.latencyMs.toFixed(1)} ms · xrun {testState.xruns}</p><span className="settings-input-meter" aria-label={`输入峰值 ${Math.round(testPeak * 100)}%`}><i style={{ width: `${Math.min(100, testPeak * 100)}%` }} /></span></>}
      {recordingDeviceError && <p className="device-error">{recordingDeviceError}</p>}
    </section>
    </SettingsGroup>
    <SettingsGroup title="通用与显示" description="关闭窗口行为与桌面歌词样式" summary={`歌词 ${draft.desktopLyricsFontSize} px · ${draft.closeToTrayWhileWorking ? '任务进行时留在托盘' : '关闭即退出'}`} icon={<FileText />} {...groupProps('general')}>
    <section className="settings-section"><h3><SlidersHorizontal />窗口行为</h3><label>关闭窗口时<select value={draft.closeToTrayWhileWorking ? 'tray' : 'quit'} onChange={(event) => setDraft({ ...draft, closeToTrayWhileWorking: event.target.value === 'tray' })}><option value="tray">有任务时留在托盘</option><option value="quit">直接退出</option></select></label></section>
    <section className="settings-section"><h3><FileText />桌面歌词</h3>
      <label>桌面歌词文字大小 · {draft.desktopLyricsFontSize} px
        <input type="range" min={16} max={64} step={1} value={draft.desktopLyricsFontSize} onChange={(event) => setDraft({ ...draft, desktopLyricsFontSize: Number(event.target.value) })} />
      </label>
      <p style={{ fontSize: draft.desktopLyricsFontSize, overflowWrap: 'anywhere' }}>桌面歌词预览</p>
      <p className="source-note">16–64 px，保存后生效。练习室与排练室共用此字号。</p>
    </section>
    </SettingsGroup>
    <SettingsGroup title="网络与共享" description="局域网练琴、下载源与代理" summary={`${runtimeSourcePreset === 'china' ? '中国大陆镜像' : runtimeSourcePreset === 'official' ? '官方源' : '自定义下载源'} · ${draft.network.proxyMode === 'system' ? '系统代理' : draft.network.proxyMode === 'manual' ? '手动代理' : '不使用代理'}`} icon={<ShieldCheck />} {...groupProps('network')}>
    <LanSettings />
    <section className="settings-section"><h3><ShieldCheck />高级网络</h3>
      <div className="settings-grid">
        <label>环境下载源<select value={runtimeSourcePreset} onChange={(event) => {
          const preset = event.target.value
          if (preset === 'china' || preset === 'official') selectRuntimeSourcePreset(preset)
        }}><option value="china">中国大陆镜像（推荐）</option><option value="official">官方源</option><option value="custom" disabled>自定义地址</option></select></label>
        <label>代理<select value={draft.network.proxyMode} onChange={(event) => patchNetwork({ proxyMode: event.target.value as AppSettings['network']['proxyMode'] })}><option value="system">使用系统代理</option><option value="manual">手动代理</option><option value="none">不使用代理</option></select></label>
        {draft.network.proxyMode === 'manual' && <label>代理地址<input type="password" autoComplete="off" value={draft.network.proxyUrl} onChange={(event) => patchNetwork({ proxyUrl: event.target.value })} placeholder="https://user:password@host:port" /></label>}
      </div>
      <label>CPython 安装镜像<input value={draft.network.pythonInstallMirror} onChange={(event) => patchNetwork({ pythonInstallMirror: event.target.value })} placeholder="留空使用 uv 官方源" /></label>
      <label>Python 包镜像<input value={draft.network.pythonIndexUrl} onChange={(event) => patchNetwork({ pythonIndexUrl: event.target.value })} /></label>
      <label>PyTorch wheel 源<input value={draft.network.pytorchIndexUrl} onChange={(event) => patchNetwork({ pytorchIndexUrl: event.target.value })} placeholder="留空由 uv 自动选择官方后端" /></label>
      <p className="security-note"><ShieldCheck size={13} />Python 与桌面工具可使用所选镜像；分轨权重始终从固定仓库下载并按内置清单校验，代理凭据不会写入日志。</p>
    </section>
    </SettingsGroup>
    <SettingsGroup title="存储与诊断" description="数据目录、调试日志与故障排查" summary={`Debug ${draft.debugMode ? '已开启' : '已关闭'}`} icon={<FolderOpen />} {...groupProps('storage')}>
    <section className="settings-section"><h3><FolderOpen />存储位置</h3><label className="path-field">数据目录<div className="path-picker"><input readOnly value={dataRoot} title={dataRoot} /><button className="outline-button" type="button" onClick={() => void chooseDataRoot()}><FolderOpen size={15} />浏览</button></div></label><p className="security-note">歌曲、运行环境和分轨资源将分别保存在 music、envs 和 envs/models 子目录中。</p></section>
    <section className="settings-section"><h3><Bug />调试与诊断</h3>
      <div className="debug-settings-row">
        <label className="settings-toggle"><input type="checkbox" aria-label="Debug 模式" checked={draft.debugMode} disabled={debugModeSaving} onChange={(event) => void toggleDebugMode(event.target.checked)} /><span><b>Debug 模式</b><small>{debugModeSaving ? '正在保存…' : '切换后立即生效，记录主进程、IPC 调用和界面控制台日志'}</small></span></label>
        <button className="outline-button" type="button" onClick={() => void revealDebugLog()}><FolderOpen size={15} />打开日志位置</button>
      </div>
      <p className="security-note">仅在 Debug 模式开启期间追加详细日志；代理凭据、令牌和密码会自动脱敏。</p>
      {debugLogError && <p className="device-error">{debugLogError}</p>}
    </section>
    </SettingsGroup>
    </div>
    <p className="settings-overview-note">选择分类查看详细选项，返回分类后会保留本次修改。</p>
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    </div>
    <footer className="drawer-footer sticky"><Dialog.Close className="outline-button">取消</Dialog.Close><button className="primary-button" disabled={saving || debugModeSaving} onClick={() => void saveSettings()}>{saving ? '正在保存…' : '保存设置'}</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function ExportDialog({ open, onOpenChange, song, practice, onBeforeStart }: { open: boolean; onOpenChange(open: boolean): void; song: SongDetail; practice: PracticeState; onBeforeStart(): Promise<void> }): React.JSX.Element {
  const [kind, setKind] = useState<'stems' | 'mix'>('mix')
  const [format, setFormat] = useState<ExportFormat>('flac')
  const allAvailable = useMemo(() => STEM_ORDER.filter((type) => song.stems.some((stem) => stem.type === type)), [song])
  const available = useMemo(
    () => allAvailable.filter((type) => song.sourceFormat === 'existing-stems' || isStemVisible(type, practice.guitarSplitEnabled)),
    [allAvailable, practice.guitarSplitEnabled, song.sourceFormat]
  )
  const hiddenGuitarAlternatives = useMemo(
    () => allAvailable.filter((type) => song.sourceFormat !== 'existing-stems' && !isStemVisible(type, practice.guitarSplitEnabled)),
    [allAvailable, practice.guitarSplitEnabled, song.sourceFormat]
  )
  const [selected, setSelected] = useState<StemType[]>(available)
  const [includeHiddenGuitars, setIncludeHiddenGuitars] = useState(false)
  const [applyRate, setApplyRate] = useState(false)
  const [applyLoop, setApplyLoop] = useState(false)
  const [includeTake, setIncludeTake] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const activeRecordings = useMemo(() => song.recordingTracks.flatMap((track) => {
    const take = song.recordingTakes.find((candidate) => candidate.id === track.activeTakeId)
    return take ? [{ track, take }] : []
  }), [song.recordingTakes, song.recordingTracks])
  const takePracticeMatches = activeRecordings.length > 0
    && activeRecordings.every(({ take }) => Math.abs(take.playbackRate - practice.playbackRate) < 0.0001
      && (take.pitchSemitones ?? 0) === practice.pitchSemitones)
  useEffect(() => {
    if (!open) return
    setSelected(available)
    setIncludeHiddenGuitars(false)
    setMessage('')
    setIncludeTake(takePracticeMatches)
    if (takePracticeMatches) setApplyRate(true)
  }, [open, available, practice.pitchSemitones, takePracticeMatches])
  const start = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      await onBeforeStart()
      const outputPath = await window.bandbuddy.export.choosePath(kind, format, song.title)
      if (!outputPath) return
      const requestedStems = kind === 'stems' && includeHiddenGuitars
        ? [...selected, ...hiddenGuitarAlternatives.filter((type) => !selected.includes(type))]
        : selected.filter((type) => song.sourceFormat === 'existing-stems' || isStemVisible(type, practice.guitarSplitEnabled))
      const result = await window.bandbuddy.export.start({
        songId: song.id, kind, format, stemTypes: requestedStems, outputPath,
        applyPlaybackRate: kind === 'mix' && (applyRate || includeTake), playbackRate: practice.playbackRate,
        applyPitchShift: practice.pitchSemitones !== 0, pitchSemitones: practice.pitchSemitones,
        applyLoopRange: kind === 'mix' && applyLoop, loopStartMs: practice.loopStartMs, loopEndMs: practice.loopEndMs,
        overwriteMode: 'ask',
        includeActiveTake: kind === 'mix' && includeTake
      })
      setMessage(`已加入任务队列 · ${result.outputPaths.length} 个文件`)
    } catch (error) {
      if (!isCancellationError(error)) setMessage(toUserErrorMessage(error, '导出失败，请重试'))
    } finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="dialog-content export-dialog" data-dialog-open="true" aria-describedby={undefined}>
    <Dialog.Title>导出音频</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close><p className="dialog-lead">导出会保留当前升降调；当前混音还会应用练习室的 Mute、Solo 与增益。</p>
    <div className="dialog-tabs"><button className={kind === 'mix' ? 'active' : ''} onClick={() => setKind('mix')}><SlidersHorizontal />导出当前混音</button><button className={kind === 'stems' ? 'active' : ''} onClick={() => setKind('stems')}><FileAudio />分别导出音轨</button></div>
    <fieldset><legend>选择音轨</legend><div className="export-stems">{available.map((type) => <label key={type} style={{ '--track': STEM_META[type].color } as React.CSSProperties}><input type="checkbox" checked={selected.includes(type)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, type] : current.filter((item) => item !== type))} /><i /><span>{song.stems.find((stem) => stem.type === type)?.name || STEM_META[type].shortLabel}<small>{STEM_META[type].label}</small></span></label>)}</div></fieldset>
    {kind === 'stems' && hiddenGuitarAlternatives.length > 0 && <label className="check-line"><input type="checkbox" checked={includeHiddenGuitars} onChange={(event) => setIncludeHiddenGuitars(event.target.checked)} /><span>包含隐藏吉他备选轨 <small>{hiddenGuitarAlternatives.map((type) => STEM_META[type].shortLabel).join(' / ')}</small></span></label>}
    <fieldset><legend>输出格式</legend><div className="format-options">{(['wav', 'flac', 'mp3'] as const).map((item) => <button className={format === item ? 'active' : ''} onClick={() => setFormat(item)} key={item}><b>{item.toUpperCase()}</b><small>{item === 'mp3' ? '320 kbps' : '44.1 kHz · 24-bit'}</small></button>)}</div></fieldset>
    <div className="export-pitch-note"><AudioLines size={17} /><span><b>{practice.pitchSemitones === 0 ? '按原调导出' : `导出当前 ${practice.pitchSemitones > 0 ? '+' : '−'}${Math.abs(practice.pitchSemitones)} 半音`}</b><small>Signalsmith 处理所有非鼓轨，鼓轨保持原音</small></span></div>
    {kind === 'mix' && <fieldset><legend>混音范围</legend><label className="check-line"><input type="checkbox" checked={applyRate || includeTake} disabled={includeTake} onChange={(event) => setApplyRate(event.target.checked)} /><span>应用当前速度 <small>{practice.playbackRate.toFixed(2)}×，保持音高</small></span></label><label className="check-line"><input type="checkbox" disabled={practice.loopStartMs === null || practice.loopEndMs === null} checked={applyLoop} onChange={(event) => setApplyLoop(event.target.checked)} /><span>仅导出当前 A–B <small>默认导出整首歌曲</small></span></label>{activeRecordings.length > 0 && <label className="check-line"><input type="checkbox" checked={includeTake} disabled={!takePracticeMatches} onChange={(event) => { setIncludeTake(event.target.checked); if (event.target.checked) setApplyRate(true) }} /><span>包含{activeRecordings.length === 1 ? `“${activeRecordings[0]!.track.name}”` : `${activeRecordings.length} 条录音轨`} <small>{takePracticeMatches ? `绑定 ${practice.playbackRate.toFixed(2)}× · ${practice.pitchSemitones === 0 ? '原调' : `${practice.pitchSemitones > 0 ? '+' : '−'}${Math.abs(practice.pitchSemitones)} 半音`}` : '部分录音轨的速度或调性不匹配，请先切回录制设置'}</small></span></label>}</fieldset>}
    {message && <p className="export-message"><Check />{message}</p>}<footer className="dialog-footer"><Dialog.Close className="outline-button">关闭</Dialog.Close><button className="primary-button" disabled={busy || selected.length === 0} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" /> : <Upload />}选择位置并导出</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function MetadataDialog({ open, onOpenChange, song, onSaved }: { open: boolean; onOpenChange(open: boolean): void; song: SongDetail; onSaved(song: SongDetail): void }): React.JSX.Element {
  const parsedKey = parseMusicalKey(song.musicalKey)
  const [title, setTitle] = useState(song.title)
  const [artist, setArtist] = useState(song.artist)
  const [bpm, setBpm] = useState(song.bpm?.toString() ?? '')
  const [time, setTime] = useState(song.timeSignature ?? '')
  const [keyTonic, setKeyTonic] = useState<MusicalKeyTonic | ''>(parsedKey?.tonic ?? '')
  const [keyMode, setKeyMode] = useState<MusicalKeyMode>(parsedKey?.mode ?? 'major')
  const [keySource, setKeySource] = useState<MusicalKeySource | null>(song.musicalKeySource)
  const [analysis, setAnalysis] = useState<MusicalKeyAnalysis | null>(song.keyAnalysis)
  const [detectingKey, setDetectingKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const parsed = parseMusicalKey(song.musicalKey)
    setTitle(song.title)
    setArtist(song.artist)
    setBpm(song.bpm?.toString() ?? '')
    setTime(song.timeSignature ?? '')
    setKeyTonic(parsed?.tonic ?? '')
    setKeyMode(parsed?.mode ?? 'major')
    setKeySource(song.musicalKeySource)
    setAnalysis(song.keyAnalysis)
    setError('')
  }, [song, open])

  const detectKey = async (): Promise<void> => {
    setDetectingKey(true)
    setError('')
    try {
      const detected = await window.bandbuddy.media.detectKey(song.id)
      setAnalysis(detected)
      if (keySource !== 'manual' || !keyTonic) {
        setKeyTonic(detected.tonic)
        setKeyMode(detected.mode)
        setKeySource('detected')
      }
    } catch (reason) {
      setError(toUserErrorMessage(reason, '歌曲调识别失败，请检查音轨后重试'))
    } finally {
      setDetectingKey(false)
    }
  }

  const useDetectedKey = (): void => {
    if (!analysis) return
    setKeyTonic(analysis.tonic)
    setKeyMode(analysis.mode)
    setKeySource('detected')
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const musicalKey = keyTonic ? formatMusicalKey(keyTonic, keyMode) : null
      const saved = await window.bandbuddy.library.update({
        id: song.id,
        patch: {
          title,
          artist,
          bpm: bpm ? Number(bpm) : null,
          musicalKey,
          musicalKeySource: musicalKey ? keySource ?? 'manual' : null,
          timeSignature: time || null
        }
      })
      onSaved(saved)
      onOpenChange(false)
    } catch (reason) {
      setError(toUserErrorMessage(reason, '歌曲信息保存失败，请检查输入'))
    } finally {
      setSaving(false)
    }
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" data-dialog-open="true" /><Dialog.Content className="dialog-content metadata-dialog" data-dialog-open="true" aria-describedby={undefined}>
    <Dialog.Title>编辑歌曲信息</Dialog.Title><Dialog.Close className="dialog-close"><X /></Dialog.Close>
    <div className="metadata-scroll">
      <div className="form-stack">
        <label>歌曲标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>艺术家<input value={artist} onChange={(event) => setArtist(event.target.value)} /></label>
        <div className="form-row"><label>BPM（可修改）<input type="number" min="20" max="400" value={bpm} onChange={(event) => setBpm(event.target.value)} /></label><label>拍号<input placeholder="例如 4/4" value={time} onChange={(event) => setTime(event.target.value)} /></label></div>
      </div>

      <section className="key-analysis-section">
        <header><span><b>歌曲调</b><small>本地分析非鼓轨，识别主音与大小调</small></span><button className="outline-button" disabled={detectingKey} onClick={() => void detectKey()}>{detectingKey ? <LoaderCircle className="spin" size={15} /> : <AudioLines size={15} />}{detectingKey ? '正在分析…' : analysis ? '重新识别' : '识别歌曲调'}</button></header>
        {analysis ? <>
          <div className={`key-result ${analysis.lowConfidence ? 'low-confidence' : ''}`}>
            <span><small>识别结果</small><strong>{analysis.label}</strong></span>
            <em>{Math.round(analysis.confidence * 100)}%</em>
          </div>
          {analysis.lowConfidence && <div className="key-candidates"><small>置信度较低，前三候选</small><div>{analysis.candidates.map((candidate) => <span key={candidate.label}>{candidate.label} <b>{Math.round(candidate.confidence * 100)}%</b></span>)}</div></div>}
          {analysis.segments.length > 0 && <div className="key-segments"><h4>分段检测</h4>{analysis.segments.map((segment, index) => <article className={segment.possibleModulation ? 'modulation' : ''} key={`${segment.startMs}-${segment.label}`}><i /> <span><b>{formatTime(segment.startMs)}–{formatTime(segment.endMs)}</b><small>{segment.label} · {Math.round(segment.confidence * 100)}%</small></span>{segment.possibleModulation && <em>可能转调</em>}{index === 0 && !segment.possibleModulation && <em className="base-key">主调</em>}</article>)}</div>}
          <p className="key-analysis-meta">分析 {analysis.analyzedStems.map((stem) => STEM_META[stem].label).join('、')} · {formatTime(analysis.analyzedDurationMs)}</p>
        </> : <div className="key-empty"><AudioLines /><span><b>尚未识别歌曲调</b><small>识别后会显示置信度、前三候选与可能转调的片段。</small></span></div>}

        <div className="manual-key-row"><label>主音<select value={keyTonic} onChange={(event) => { setKeyTonic(event.target.value as MusicalKeyTonic | ''); setKeySource(event.target.value ? 'manual' : null) }}><option value="">未设置</option>{MUSICAL_KEY_TONICS.map((tonic) => <option value={tonic} key={tonic}>{tonic}</option>)}</select></label><label>调式<select value={keyMode} disabled={!keyTonic} onChange={(event) => { setKeyMode(event.target.value as MusicalKeyMode); setKeySource('manual') }}><option value="major">Major · 大调</option><option value="minor">Minor · 小调</option></select></label>{analysis && <button className="outline-button" disabled={keySource === 'detected' && keyTonic === analysis.tonic && keyMode === analysis.mode} onClick={useDetectedKey}>使用识别结果</button>}</div>
        <p className="key-source-note">{keyTonic ? keySource === 'manual' ? '当前采用手动纠正；重新识别不会覆盖。' : '当前采用识别结果，可随时手动纠正。' : '当前未设置歌曲调。'}</p>
      </section>
      <p className="security-note">BPM 可在练习室的节拍器中检测；歌曲调识别与音频分析均在本机完成。</p>
      {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
    </div>
    <footer className="dialog-footer"><Dialog.Close className="outline-button">取消</Dialog.Close><button className="primary-button" disabled={saving || detectingKey || !title.trim()} onClick={() => void save()}>{saving && <LoaderCircle className="spin" size={16} />}保存</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function SongActionsDialog({
  open, onOpenChange, song, onOpen, onEditMetadata, onImportLyrics, onReveal, onReseparate, onDelete
}: {
  open: boolean
  onOpenChange(open: boolean): void
  song: SongSummary | null
  onOpen(): void
  onEditMetadata(): void
  onImportLyrics(): void
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
      <button onClick={() => { onOpenChange(false); onEditMetadata() }}><Pencil /><span><b>编辑歌曲信息</b><small>修改标题、艺术家、BPM、调号和拍号</small></span></button>
      <button onClick={() => { onOpenChange(false); onImportLyrics() }}><FileText /><span><b>导入 / 替换 LRC 歌词</b><small>读取带时间标签的 .lrc 文件，用于桌面歌词</small></span></button>
      <button onClick={() => { onOpenChange(false); onReveal() }}><FolderOpen /><span><b>在文件管理器中显示</b><small>打开 UUID 管理目录，不暴露给网页内容</small></span></button>
      <button disabled={song?.status !== 'ready'} onClick={() => { onOpenChange(false); onReseparate() }}><RefreshCw /><span><b>重新分轨</b><small>成功前继续使用当前分轨版本</small></span></button>
      <button className="danger" onClick={() => setConfirmDelete(true)}><Trash2 /><span><b>删除歌曲</b><small>受管目录会移入系统废纸篓 / 回收站</small></span></button>
    </div>
    {confirmDelete && <div className="inline-warning danger"><AlertTriangle /><span><b>确认删除“{song?.title}”？</b><small>播放会停止，相关任务会取消；文件可从系统废纸篓 / 回收站恢复。</small></span><button onClick={() => { onOpenChange(false); onDelete() }}>确认删除</button><button onClick={() => setConfirmDelete(false)}>取消</button></div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
