import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChartNoAxesColumnIncreasing,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Guitar,
  Lightbulb,
  Settings2,
  Target,
  X
} from 'lucide-react'
import { LabSelect, Segments } from './LabControls.js'
import { readSettings, type LabSettings } from './lab-settings.js'
import { mod, noteName, parseNote, positions, ROOTS, type Position, type Tuning } from './theory.js'
import {
  choosePracticePosition,
  chromaticDegrees,
  cellId,
  degreeFor,
  inMaterial,
  LAB_TUNINGS,
  mastery,
  positionShapes,
  progressKey,
  readProgress,
  recordAnswer,
  SCALES,
  CHORDS,
  TRAINING_STAGES,
  triadShapes,
  weakPositions,
  type LabModule,
  type PositionSystem
} from './lab-model.js'
import { LabDetails } from './LabDetails.js'
import { LabBoard, type LabMarker } from './LabBoard.js'
import type { WoodshedAudio } from './audio.js'
import './fretboard-lab.css'

const MODULES = [
  { id: 'notes', name: '音名', en: 'Notes' },
  { id: 'degrees', name: '音级', en: 'Degrees' },
  { id: 'chords', name: '和弦', en: 'Chords' },
  { id: 'positions', name: '把位', en: 'Positions' }
] as const
const INSTRUMENTS = [
  { id: 'guitar', name: '吉他' },
  { id: 'bass', name: '贝斯' },
  { id: 'ukulele', name: '尤克里里' },
  { id: 'guitar-7', name: '七弦吉他' },
  { id: 'bass-5', name: '五弦贝斯' }
]
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const today = (): string => new Date().toLocaleDateString('sv-SE')
interface Task {
  target: Position
  required: Position[]
  text: string
  found: string[]
  tried: string[]
  complete: boolean
  hinted: boolean
  started: number
}
const formatTime = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

export function FretboardLab({
  initialTuning,
  audio,
  a4,
  onBack,
  onError
}: {
  initialTuning: Tuning
  audio: WoodshedAudio | null
  a4: number
  onBack(): void
  onError(message: string): void
}): React.JSX.Element {
  const [settings, setSettings] = useState(() => readSettings(initialTuning))
  const [module, setModule] = useState<LabModule>('notes')
  const [mode, setMode] = useState<'explore' | 'train'>('explore')
  const [filter, setFilter] = useState<'all' | 'natural' | 'single'>('all')
  const [single, setSingle] = useState(0)
  const [labels, setLabels] = useState<'notes' | 'degrees' | 'hints' | 'hidden'>('notes')
  const [overlay, setOverlay] = useState<'scale' | 'chord' | 'interval' | 'none'>('scale')
  const [selected, setSelected] = useState<Position | null>(() =>
    settings.tuningId === 'guitar' && !settings.customNotes ? { string: 5, fret: 3, midi: 48 } : null
  )
  const [system, setSystem] = useState<PositionSystem>('caged')
  const [shapeIndex, setShapeIndex] = useState(0)
  const [connections, setConnections] = useState(false)
  const [triads, setTriads] = useState(false)
  const [stringGroup, setStringGroup] = useState(1)
  const [degrees, setDegrees] = useState<number[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [progress, setProgress] = useState(readProgress)
  const [custom, setCustom] = useState('')
  const [customError, setCustomError] = useState('')
  const [stage, setStage] = useState(-1)
  const [noteTask, setNoteTask] = useState<'identify' | 'find' | 'recall'>('find')
  const [degreeScope, setDegreeScope] = useState<'all' | 'near' | 'group'>('all')
  const [randomRoot, setRandomRoot] = useState(false)
  const [task, setTask] = useState<Task | null>(null)
  const [feedback, setFeedback] = useState('')
  const [wrongCell, setWrongCell] = useState<string | null>(null)
  const [session, setSession] = useState({
    correct: 0,
    wrong: 0,
    streak: 0,
    seconds: 0
  })
  const [playing, setPlaying] = useState(false)
  const playbackTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const storageFailed = useRef(false)
  const [direction, setDirection] = useState('up')
  const tuning = useMemo(() => {
    const preset = LAB_TUNINGS.find((t) => t.id === settings.tuningId) ?? LAB_TUNINGS[0]!
    return settings.customNotes ? { ...preset, notes: settings.customNotes } : preset
  }, [settings.tuningId, settings.customNotes])
  const { root, min, max } = settings
  const scale = SCALES[settings.scale]!
  const chord = CHORDS[settings.chord]!
  const material = module === 'chords' || overlay === 'chord' ? chord : scale
  const effectiveScale =
    system === 'pent' ? SCALES[settings.scale === 'major-pent' ? 'major-pent' : 'minor-pent']! : scale
  const all = useMemo(
    () => positions(tuning, 0, min, max, settings.strings),
    [tuning, min, max, settings.strings]
  )
  const weak = useMemo(() => weakPositions(progress, tuning), [progress, tuning])
  const shapes = useMemo(
    () =>
      module === 'chords' && triads
        ? triadShapes(tuning, root, chord, [stringGroup, stringGroup + 1, stringGroup + 2], min, max)
        : positionShapes(tuning, root, effectiveScale, system),
    [module, triads, tuning, root, chord, stringGroup, min, max, effectiveScale, system]
  )
  const currentShape = shapes[mod(shapeIndex, Math.max(1, shapes.length))]
  const shapeIds = useMemo(() => new Set(currentShape?.notes.map(cellId)), [currentShape])
  const adjacentIds = useMemo(
    () =>
      new Set(
        connections
          ? [-1, 1].flatMap(
              (offset) =>
                shapes[mod(shapeIndex + offset, Math.max(1, shapes.length))]?.notes.map(cellId) ?? []
            )
          : []
      ),
    [connections, shapes, shapeIndex]
  )
  const instrument = tuning.id === 'guitar-7' || tuning.id === 'bass-5' ? tuning.id : tuning.instrument
  const tuningOptions = LAB_TUNINGS.filter((t) =>
    instrument === 'guitar-7' || instrument === 'bass-5'
      ? t.id === instrument
      : t.instrument === instrument && !['guitar-7', 'bass-5'].includes(t.id)
  )
  const patch = (value: Partial<LabSettings>): void => {
    setSettings((old) => ({ ...old, ...value }))
    setTask(null)
    setFeedback('')
    setWrongCell(null)
    stopPlayback()
  }
  const stopPlayback = (): void => {
    playbackTimers.current.forEach(clearTimeout)
    playbackTimers.current = []
    audio?.stop()
    setPlaying(false)
  }
  useEffect(
    () => () => {
      playbackTimers.current.forEach(clearTimeout)
      audio?.stop()
    },
    [audio]
  )
  useEffect(() => {
    try {
      localStorage.setItem('bandbuddy.fretboard-settings.v1', JSON.stringify(settings))
      localStorage.setItem('bandbuddy.fretboard-progress.v1', JSON.stringify(progress))
    } catch {
      if (!storageFailed.current) {
        storageFailed.current = true
        onError('本地存储不可用，本次指板设置与训练记录无法保存。')
      }
    }
  }, [settings, progress, onError])
  useEffect(() => {
    if (mode !== 'train' || !task || task.complete || progressOpen || settingsOpen || helpOpen) return
    const timer = setInterval(() => {
      setSession((old) => ({ ...old, seconds: old.seconds + 1 }))
      const day = today()
      setProgress((old) => ({
        ...old,
        days: { ...old.days, [day]: (old.days[day] ?? 0) + 1 }
      }))
    }, 1000)
    return () => clearInterval(timer)
  }, [mode, Boolean(task), task?.complete, progressOpen, settingsOpen, helpOpen])
  const preview = (midi: number): void => {
    void audio?.preview(midi).catch((e) => onError(`无法试听：${e instanceof Error ? e.message : String(e)}`))
  }
  const playMaterial = (): void => {
    if (playing) {
      stopPlayback()
      return
    }
    stopPlayback()
    const closingOctave = 12 * (Math.floor(Math.max(...material.semitones) / 12) + 1)
    const tones = material.semitones.map((n) => 48 + root + n).concat(48 + root + closingOctave)
    const sequence =
      direction === 'down'
        ? [...tones].reverse()
        : direction === 'both'
          ? [...tones, ...[...tones].reverse().slice(1)]
          : tones
    setPlaying(true)
    sequence.forEach((midi, i) => playbackTimers.current.push(setTimeout(() => preview(midi), i * 350)))
    playbackTimers.current.push(setTimeout(() => setPlaying(false), sequence.length * 350))
  }
  const changeModule = (next: LabModule): void => {
    setModule(next)
    setTask(null)
    setStage(-1)
    setFeedback('')
    setShapeIndex(0)
    setDegrees([])
    setOverlay('scale')
    setLabels(next === 'notes' ? 'notes' : 'degrees')
    setWrongCell(null)
    stopPlayback()
    if (next === 'positions' && system === 'caged') setSettings((old) => ({ ...old, scale: 'major' }))
    if (next === 'positions' && system === 'three' && scale.semitones.length !== 7)
      setSettings((old) => ({ ...old, scale: 'major' }))
    if (next === 'positions' && system === 'pent' && !['minor-pent', 'major-pent'].includes(settings.scale))
      setSettings((old) => ({ ...old, scale: 'minor-pent' }))
  }
  const changeInstrument = (id: string): void => {
    const next = LAB_TUNINGS.find((t) => t.id === id || t.instrument === id)!
    patch({
      tuningId: next.id,
      customNotes: null,
      strings: [],
      min: 0,
      max: 12
    })
    setSelected(null)
    setShapeIndex(0)
    setStringGroup(1)
    setCustomError('')
    setCustom(next.notes.map((n) => noteName(n)).join(' '))
  }
  const startTask = (): void => {
    stopPlayback()
    setProgressOpen(false)
    setSettingsOpen(false)
    setMode('train')
    setWrongCell(null)
    setFeedback('')
    let pool = all
    const stageConfig = stage >= 0 ? TRAINING_STAGES[stage] : undefined
    if (stageConfig && 'boundary' in stageConfig) pool = pool.filter((p) => p.fret === 0 || p.fret === 12)
    if (
      module === 'notes' &&
      (filter === 'natural' || (stageConfig && 'naturals' in stageConfig && stageConfig.naturals))
    )
      pool = pool.filter((p) => !noteName(p.midi, false).includes('#'))
    if (module === 'notes' && filter === 'single' && stage !== 4)
      pool = pool.filter((p) => mod(p.midi) === single)
    if (stage === 4) pool = pool.filter((p) => pool.some((other) => Math.abs(other.midi - p.midi) === 12))
    const anchor = choosePracticePosition(pool, progress, tuning, task?.target)
    if (!anchor) {
      setTask(null)
      setFeedback('当前范围没有可练习的位置，请调整弦组或品位。')
      return
    }
    let taskRoot = root
    let taskChord = chord
    if (stageConfig && 'changes' in stageConfig) {
      const changes = [
        { root: 2, chord: 'm7' },
        { root: 7, chord: '7' },
        { root: 0, chord: 'maj7' }
      ]
      const next = changes[task ? (changes.findIndex((change) => change.root === root) + 1) % 3 : 0]!
      taskRoot = next.root
      taskChord = CHORDS[next.chord]!
      setSettings((old) => ({ ...old, root: next.root, chord: next.chord }))
    }
    if (randomRoot && module === 'degrees') {
      taskRoot = Math.floor(Math.random() * 12)
      setSettings((old) => ({ ...old, root: taskRoot }))
    }
    let required: Position[], text: string
    if (module === 'notes') {
      const targetPc = filter === 'single' ? single : mod(anchor.midi)
      required =
        stage === 4
          ? pool.filter((p) => Math.abs(p.midi - anchor.midi) === 12)
          : noteTask === 'find'
            ? pool.filter((p) => mod(p.midi) === targetPc)
            : [anchor]
      text =
        stage === 4
          ? `找到 ${noteName(anchor.midi)} 的八度 · 锚点 ${anchor.string} 弦 ${anchor.fret} 品`
          : noteTask === 'find'
            ? `找到所有 ${NOTES[targetPc]}`
            : `这个位置是什么音？ ${anchor.string} 弦 · ${anchor.fret} 品`
    } else if (module === 'degrees') {
      const allowed =
        stageConfig && 'degree' in stageConfig
          ? [...stageConfig.degree]
          : degrees.length
            ? degrees
            : [0, 2, 3, 4, 5, 7, 9, 10, 11]
      const scoped = pool.filter(
        (p) =>
          (degreeScope !== 'near' || Math.abs(p.fret - anchor.fret) <= 4) &&
          (degreeScope !== 'group' || Math.abs(p.string - anchor.string) <= 1)
      )
      const reachable = allowed.filter((degree) => scoped.some((p) => mod(p.midi - taskRoot) === degree))
      const degree = reachable[Math.floor(Math.random() * reachable.length)]
      required = scoped.filter((p) => mod(p.midi - taskRoot) === degree)
      text = `Root：${ROOTS[taskRoot]} · 找到 ${degree === undefined ? '目标音级' : chromaticDegrees[degree]}${degreeScope === 'near' ? `（${Math.max(min, anchor.fret - 4)}–${Math.min(max, anchor.fret + 4)} 品）` : degreeScope === 'group' ? `（${Math.max(1, anchor.string - 1)}–${Math.min(tuning.notes.length, anchor.string + 1)} 弦）` : ''}`
    } else if (module === 'chords') {
      required = triads
        ? pool.filter((p) => shapeIds.has(cellId(p)))
        : pool.filter((p) => inMaterial(p, taskRoot, taskChord))
      text = triads
        ? `重建 ${ROOTS[taskRoot]} ${taskChord.name} · ${currentShape?.name ?? '三和弦'}`
        : `${stageConfig && 'changes' in stageConfig ? 'ii–V–I · ' : ''}找到 ${ROOTS[taskRoot]} ${taskChord.name} 的全部和弦音`
    } else {
      required = pool.filter((p) => shapeIds.has(cellId(p)))
      text = `重建 ${ROOTS[root]} · ${currentShape?.name ?? '把位'}（当前范围）`
    }
    if (!required.length) {
      setTask(null)
      setFeedback('当前范围没有目标音，请调整范围或把位。')
      return
    }
    setTask({
      target: anchor,
      required,
      text,
      found: [],
      tried: [],
      complete: false,
      hinted: false,
      started: performance.now()
    })
  }
  const answer = (p: Position, pc?: number): void => {
    if (!task || task.complete || progressOpen) return
    const identifying = module === 'notes' && noteTask !== 'find'
    const answerKey = identifying ? `note:${pc}` : cellId(p)
    if (task.found.includes(cellId(p)) || task.tried.includes(answerKey)) return
    const correct = identifying
      ? pc === mod(task.target.midi)
      : task.required.some((target) => cellId(target) === cellId(p))
    const scored = identifying ? task.target : p
    if (!task.hinted || !correct)
      setProgress((old) =>
        recordAnswer(old, tuning, module, scored, correct, performance.now() - task.started)
      )
    if (correct) {
      const found = [...task.found, cellId(scored)]
      const complete = found.length === task.required.length
      setTask({ ...task, found, complete, started: performance.now() })
      setSession((old) => ({
        ...old,
        correct: old.correct + 1,
        streak: old.streak + 1
      }))
      setFeedback(complete ? '完成！准备好后进入下一题。' : '答对了，继续找其余位置。')
      setWrongCell(null)
      preview(scored.midi)
    } else {
      setTask({ ...task, tried: [...task.tried, answerKey] })
      setSession((old) => ({ ...old, wrong: old.wrong + 1, streak: 0 }))
      setWrongCell(cellId(p))
      setFeedback('再想一想，这个答案还不对。')
    }
  }
  const marker = (p: Position): LabMarker | null => {
    const id = cellId(p)
    if (progressOpen)
      return {
        text: '',
        kind: 'natural',
        mastery: mastery(progress.cells[progressKey(tuning, p)])
      }
    if (mode === 'train') {
      if (settings.strings.length && !settings.strings.includes(p.string)) return null
      if (task?.found.includes(id)) return { text: noteName(p.midi, false), kind: 'correct' }
      if (wrongCell === id) return { text: '', kind: 'wrong' }
      if (module === 'notes' && noteTask !== 'find' && task && cellId(task.target) === id)
        return { text: '?', kind: 'target' }
      if (stage === 4 && task && cellId(task.target) === id)
        return { text: noteName(p.midi, false), kind: 'root' }
      if (task?.hinted && task.required.some((target) => cellId(target) === id))
        return {
          text: module === 'notes' ? noteName(p.midi, false) : degreeFor(p.midi, root, material),
          kind: 'ghost'
        }
      if (module === 'degrees' && mod(p.midi - root) === 0) return { text: '1', kind: 'root' }
      return null
    }
    if (overlay === 'none' || (settings.strings.length && !settings.strings.includes(p.string))) return null
    const pc = mod(p.midi),
      semitone = mod(p.midi - root),
      isRoot = semitone === 0
    let kind: LabMarker['kind'] = isRoot
      ? 'root'
      : inMaterial(p, root, material)
        ? 'tone'
        : noteName(pc, false).includes('#')
          ? 'accidental'
          : 'natural'
    if (!isRoot && (module === 'chords' || overlay === 'chord') && [3, 4, 10, 11].includes(semitone))
      kind = 'guide'
    if (
      module === 'notes' &&
      ((filter === 'natural' && noteName(pc, false).includes('#')) || (filter === 'single' && pc !== single))
    )
      return null
    if (
      module === 'degrees' &&
      (degrees.length ? !degrees.includes(semitone) : !inMaterial(p, root, material))
    )
      return null
    if ((overlay === 'chord' || module === 'chords') && !inMaterial(p, root, chord)) return null
    if (module === 'positions' || (module === 'chords' && triads)) {
      if (!shapeIds.has(id)) {
        if (adjacentIds.has(id)) kind = 'ghost'
        else return null
      }
    }
    const text =
      labels === 'hidden' || (labels === 'hints' && !isRoot)
        ? ''
        : labels === 'degrees' || overlay === 'interval'
          ? degreeFor(p.midi, root, module === 'positions' ? effectiveScale : material)
          : noteName(p.midi, false)
    return { text, kind }
  }
  const selectStage = (index: number): void => {
    setStage(index)
    setTask(null)
    setFeedback('')
    setWrongCell(null)
    if (index < 0) return
    const value = TRAINING_STAGES[index]!
    setModule(value.module)
    const low = Array.from({ length: Math.min(2, tuning.notes.length) }, (_, i) => tuning.notes.length - i)
    patch({
      min: value.range[0],
      max: Math.min(value.range[1], tuning.frets),
      strings: value.strings === 'low' ? low : [],
      ...('chord' in value ? { chord: value.chord } : {}),
      ...('system' in value ? { scale: 'major' } : {})
    })
    if ('task' in value) setNoteTask(value.task)
    if ('naturals' in value) setFilter(value.naturals ? 'natural' : 'all')
    if ('degree' in value) setDegrees([...value.degree])
    if ('system' in value) {
      setSystem(value.system)
      setShapeIndex(0)
    }
    setTriads(false)
  }
  return (
    <section className="fl-page">
      <header className="fl-header">
        <button className="fl-icon" aria-label="返回练功房" onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
        <Guitar className="fl-brand" size={36} strokeWidth={1.4} />
        <div className="fl-title">
          <h1>指板实验室</h1>
          <p>EXPLORE · PRACTICE · MASTER THE FRETBOARD</p>
        </div>
        <span className="fl-motto">音乐让生活更美好</span>
        <button
          className="fl-icon"
          aria-label="使用帮助"
          aria-pressed={helpOpen}
          onClick={() => setHelpOpen(!helpOpen)}
        >
          <CircleHelp size={21} />
        </button>
        <button
          className="fl-icon"
          aria-label="指板设置"
          aria-pressed={settingsOpen}
          onClick={() => {
            setSettingsOpen(!settingsOpen)
            setCustom(tuning.notes.map((n) => noteName(n)).join(' '))
          }}
        >
          <Settings2 size={21} />
        </button>
        <button
          className="fl-icon"
          aria-label="训练进度"
          aria-pressed={progressOpen}
          onClick={() => {
            setProgressOpen(!progressOpen)
            setTask((old) => (old ? { ...old, started: performance.now() } : null))
          }}
        >
          <ChartNoAxesColumnIncreasing size={21} />
        </button>
      </header>
      {helpOpen && (
        <div className="fl-inline-panel">
          <b>探索 → 隐藏提示 → 主动训练</b>
          <p>
            点击指板音符查看音名、音级与音高并试听。训练时答案隐藏，音名识别用下方音符按钮回答，其他任务直接点击指板。提示不会计入掌握度；热图综合答题正确率、反应时间与练习次数。
          </p>
          <button className="fl-icon" aria-label="关闭帮助" onClick={() => setHelpOpen(false)}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="fl-workspace">
        <div className="fl-top-row">
          <div className="fl-instruments">
            <LabSelect
              label="指板乐器"
              value={instrument}
              options={INSTRUMENTS}
              onChange={changeInstrument}
            />
            <LabSelect
              label="指板调弦"
              value={tuning.id}
              options={tuningOptions.map((t) => ({
                id: t.id,
                name: `${t.name.split(' · ')[1]} (${t.notes.map((n) => noteName(n, false)).join(' ')})${settings.customNotes ? ' · 自定义' : ''}`
              }))}
              onChange={(id) => {
                patch({ tuningId: id, customNotes: null })
                setSelected(null)
                setShapeIndex(0)
              }}
            />
          </div>
          <Segments
            label="实验室模式"
            value={mode}
            options={[
              ['explore', '探索模式'],
              ['train', '训练模式']
            ]}
            onChange={(value) => {
              setMode(value)
              setTask(null)
              setFeedback('')
              setProgressOpen(false)
              stopPlayback()
            }}
          />
          <div className="fl-range">
            <span>显示范围</span>
            <Segments
              label="显示范围"
              value={max}
              options={[
                [12, '0–12'],
                [15, '0–15'],
                [tuning.frets, `0–${tuning.frets}`]
              ]}
              onChange={(value) => {
                patch({ min: 0, max: value })
                setShapeIndex(0)
              }}
            />
          </div>
        </div>
        {settingsOpen && (
          <div className="fl-settings">
            <label>
              自定义调弦 <small>从第 {tuning.notes.length} 弦至第 1 弦，含八度</small>
              <input value={custom} onChange={(e) => setCustom(e.target.value)} />
            </label>
            <button
              className="fl-button"
              onClick={() => {
                const notes = custom
                  .trim()
                  .split(/[\s,，]+/)
                  .map(parseNote)
                if (notes.length !== tuning.notes.length || notes.some((n) => n === null)) {
                  setCustomError(
                    `请输入 ${tuning.notes.length} 个含八度音名，如 ${tuning.notes.map((n) => noteName(n)).join(' ')}。`
                  )
                  return
                }
                patch({ customNotes: notes as number[] })
                setCustomError('')
                setSelected(null)
              }}
            >
              应用调弦
            </button>
            <button
              className="fl-button"
              onClick={() => {
                patch({ customNotes: null })
                setCustom(
                  LAB_TUNINGS.find((t) => t.id === tuning.id)!
                    .notes.map((n) => noteName(n))
                    .join(' ')
                )
                setCustomError('')
                setSelected(null)
              }}
            >
              恢复预设
            </button>
            <label>
              起始品
              <input
                aria-label="起始品"
                type="number"
                min={0}
                max={max}
                value={min}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber
                  if (Number.isInteger(n)) patch({ min: Math.max(0, Math.min(max, n)) })
                }}
              />
            </label>
            <label>
              结束品
              <input
                aria-label="结束品"
                type="number"
                min={min}
                max={tuning.frets}
                value={max}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber
                  if (Number.isInteger(n)) patch({ max: Math.min(tuning.frets, Math.max(min, n)) })
                }}
              />
            </label>
            <label className="fl-checkbox">
              <input
                type="checkbox"
                checked={settings.leftHanded}
                onChange={(e) => patch({ leftHanded: e.target.checked })}
              />
              左手显示
            </label>
            <div className="fl-string-picker">
              <span>练习弦组</span>
              {Array.from({ length: tuning.notes.length }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  aria-pressed={!settings.strings.length || settings.strings.includes(n)}
                  onClick={() =>
                    patch({
                      strings: settings.strings.includes(n)
                        ? settings.strings.filter((s) => s !== n)
                        : [...settings.strings, n]
                    })
                  }
                >
                  {n} 弦
                </button>
              ))}
              <button onClick={() => patch({ strings: [] })}>全部</button>
            </div>
            {customError && (
              <p className="fl-error" role="alert">
                {customError}
              </p>
            )}
          </div>
        )}
        <div className="fl-module-row">
          <div className="fl-tabs" role="tablist" aria-label="指板模块">
            {MODULES.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-label={`${item.name} ${item.en}`}
                aria-selected={module === item.id}
                onClick={() => changeModule(item.id)}
              >
                <b>{item.name}</b>
                <span>{item.en}</span>
              </button>
            ))}
          </div>
          {mode === 'explore' && (
            <>
              <div className="fl-control-group">
                <span>
                  {module === 'notes' ? '显示选项' : module === 'positions' ? '把位系统' : '调性与内容'}
                </span>
                <div className="fl-control-line">
                  {module === 'notes' ? (
                    <>
                      <Segments
                        label="音名筛选"
                        value={filter}
                        options={[
                          ['all', '全部'],
                          ['natural', '自然音'],
                          ['single', '单个音']
                        ]}
                        onChange={(v) => setFilter(v as typeof filter)}
                      />
                      <LabSelect
                        label="单个音"
                        value={String(single)}
                        options={NOTES.map((name, i) => ({
                          id: String(i),
                          name
                        }))}
                        onChange={(v) => {
                          setSingle(Number(v))
                          setFilter('single')
                        }}
                      />
                    </>
                  ) : module === 'positions' ? (
                    <LabSelect
                      label="把位系统"
                      value={system}
                      options={[
                        { id: 'caged', name: 'CAGED' },
                        { id: 'three', name: '3NPS' },
                        { id: 'pent', name: 'Pentatonic' },
                        { id: 'region', name: '自定义区域' }
                      ]}
                      onChange={(v) => {
                        setSystem(v as PositionSystem)
                        setShapeIndex(0)
                        if (v === 'caged') patch({ scale: 'major' })
                        if (v === 'three') patch({ scale: 'major' })
                        if (v === 'pent') patch({ scale: 'minor-pent' })
                      }}
                    />
                  ) : (
                    <>
                      <LabSelect
                        label="根音"
                        value={String(root)}
                        options={ROOTS.map((name, i) => ({
                          id: String(i),
                          name
                        }))}
                        onChange={(v) => patch({ root: Number(v) })}
                      />
                      <LabSelect
                        label="音阶或和弦"
                        value={module === 'chords' ? settings.chord : settings.scale}
                        options={Object.entries(module === 'chords' ? CHORDS : SCALES).map(([id, value]) => ({
                          id,
                          name: value.name
                        }))}
                        onChange={(v) => {
                          patch(module === 'chords' ? { chord: v } : { scale: v })
                          setDegrees([])
                          setTriads(false)
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
              <div className="fl-control-group fl-labels">
                <span>标签显示</span>
                <Segments
                  label="标签显示"
                  value={labels}
                  options={[
                    ['notes', '音名'],
                    ['degrees', '音级'],
                    ['hints', '提示'],
                    ['hidden', '隐藏']
                  ]}
                  onChange={(v) => setLabels(v as typeof labels)}
                />
              </div>
            </>
          )}
          {mode === 'train' && (
            <div className="fl-training-options">
              <LabSelect
                label="训练阶段"
                value={String(stage)}
                options={[
                  { id: '-1', name: '自由训练' },
                  ...TRAINING_STAGES.map((s, i) => ({
                    id: String(i),
                    name: `${i + 1}. ${s.name}`
                  }))
                ]}
                onChange={(v) => selectStage(Number(v))}
              />
              {module === 'notes' && (
                <LabSelect
                  label="音名训练方式"
                  value={noteTask}
                  options={[
                    { id: 'identify', name: '识别位置' },
                    { id: 'find', name: '寻找音符' },
                    { id: 'recall', name: '全指板回忆' }
                  ]}
                  onChange={(v) => {
                    setNoteTask(v as typeof noteTask)
                    setTask(null)
                  }}
                />
              )}
              {module === 'degrees' && (
                <>
                  <LabSelect
                    label="音级训练范围"
                    value={degreeScope}
                    options={[
                      { id: 'all', name: '全指板' },
                      { id: 'near', name: '附近 ±4 品' },
                      { id: 'group', name: '当前弦组' }
                    ]}
                    onChange={(v) => {
                      setDegreeScope(v as typeof degreeScope)
                      setTask(null)
                    }}
                  />
                  <label className="fl-checkbox">
                    <input
                      type="checkbox"
                      checked={randomRoot}
                      onChange={(e) => {
                        setRandomRoot(e.target.checked)
                        setTask(null)
                      }}
                    />
                    随机 Root
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        {mode === 'explore' && module === 'degrees' && (
          <div className="fl-degree-picker">
            <span>单独选择音级</span>
            {chromaticDegrees.map((degree, i) => (
              <button
                key={i}
                aria-pressed={degrees.includes(i)}
                onClick={() =>
                  setDegrees((old) => (old.includes(i) ? old.filter((n) => n !== i) : [...old, i]))
                }
              >
                {degree}
              </button>
            ))}
            <button onClick={() => setDegrees([])}>全部</button>
          </div>
        )}
        {(module === 'positions' || (module === 'chords' && triads)) && (
          <div className="fl-shape-row">
            <button
              className="fl-icon"
              aria-label="上一个把位"
              disabled={!shapes.length}
              onClick={() => {
                setShapeIndex(shapeIndex - 1)
                setTask(null)
              }}
            >
              <ChevronLeft size={18} />
            </button>
            <b>
              {currentShape?.name ??
                (system === 'caged' ? 'CAGED 适用于标准六弦相对调弦' : '当前范围没有可用转位')}
            </b>
            <span>{shapes.length ? `${mod(shapeIndex, shapes.length) + 1} / ${shapes.length}` : ''}</span>
            <button
              className="fl-icon"
              aria-label="下一个把位"
              disabled={!shapes.length}
              onClick={() => {
                setShapeIndex(shapeIndex + 1)
                setTask(null)
              }}
            >
              <ChevronRight size={18} />
            </button>
            {module === 'positions' && (
              <label className="fl-checkbox">
                <input
                  type="checkbox"
                  checked={connections}
                  onChange={(e) => setConnections(e.target.checked)}
                />
                显示连接音
              </label>
            )}
          </div>
        )}
        {module === 'chords' && (
          <div className="fl-shape-row">
            <Segments
              label="和弦范围"
              value={triads ? 'triads' : 'all'}
              options={[
                ['all', '全指板'],
                ['triads', '三和弦转位']
              ]}
              onChange={(v) => {
                setTriads(v === 'triads')
                setShapeIndex(0)
                setTask(null)
                if (v === 'triads' && chord.semitones.length !== 3) patch({ chord: 'major' })
              }}
            />
            {triads && (
              <LabSelect
                label="三和弦弦组"
                value={String(stringGroup)}
                options={Array.from({ length: tuning.notes.length - 2 }, (_, i) => ({
                  id: String(i + 1),
                  name: `${i + 1} · ${i + 2} · ${i + 3} 弦`
                }))}
                onChange={(v) => {
                  setStringGroup(Number(v))
                  setShapeIndex(0)
                  setTask(null)
                }}
              />
            )}
          </div>
        )}
        {progressOpen ? (
          <div className="fl-progress-summary">
            <div>
              <h2>指板掌握度</h2>
              <p>
                今日训练 {Math.floor((progress.days[today()] ?? 0) / 60)} 分{' '}
                {(progress.days[today()] ?? 0) % 60} 秒 · 灰色：未练习　浅绿：需要加强　深绿：熟练
              </p>
            </div>
            {MODULES.map((item) => {
              const score = progress.modules[item.id]
              const count = score.correct + score.wrong
              return (
                <div className="fl-progress-score" key={item.id}>
                  <span>{item.name}</span>
                  <b>{count ? `${Math.round((score.correct / count) * 100)}%` : '—'}</b>
                  <small>{count} 次作答</small>
                </div>
              )
            })}
          </div>
        ) : (
          mode === 'train' && (
            <div className="fl-task">
              <div>
                <small>训练：{MODULES.find((m) => m.id === module)!.name}</small>
                <h2>{task?.text ?? '准备好，从当前范围开始练习'}</h2>
                <p>
                  {task
                    ? `进度 ${task.found.length} / ${task.required.length}`
                    : '先选择训练目标，再点击开始训练。'}
                </p>
              </div>
              <strong>{formatTime(session.seconds)}</strong>
            </div>
          )
        )}
        <LabBoard
          tuning={tuning}
          min={min}
          max={max}
          leftHanded={settings.leftHanded}
          selected={mode === 'explore' && selected ? cellId(selected) : null}
          marker={marker}
          training={mode === 'train' && !progressOpen}
          onClick={(p) => {
            if (settings.strings.length && !settings.strings.includes(p.string)) return
            if (progressOpen) {
              setSelected(p)
              return
            }
            if (mode === 'train') {
              if (module === 'notes' && noteTask !== 'find') return
              answer(p)
            } else {
              setSelected(p)
              preview(p.midi)
            }
          }}
        />
        {mode === 'explore' && !progressOpen && (
          <LabDetails
            settings={settings}
            module={module}
            system={system}
            material={module === 'positions' && overlay !== 'chord' ? effectiveScale : material}
            selected={selected}
            a4={a4}
            overlay={overlay}
            filter={filter}
            single={single}
            direction={direction}
            playing={playing}
            onRoot={(root) => {
              patch({ root })
              setShapeIndex(0)
            }}
            onContent={(value, chord) => {
              patch(chord ? { chord: value } : { scale: value })
              setShapeIndex(0)
              setDegrees([])
            }}
            onOverlay={setOverlay}
            onSingle={(note) => {
              setSingle(note)
              setFilter('single')
            }}
            onDirection={(value) => {
              setDirection(value)
              stopPlayback()
            }}
            onPlay={playMaterial}
            onPreview={preview}
          />
        )}
        {mode === 'train' && !progressOpen && (
          <div className="fl-training-footer">
            <div className="fl-answer-area">
              {module === 'notes' && noteTask !== 'find' && task ? (
                <div className="fl-note-buttons">
                  {NOTES.map((name, i) => (
                    <button
                      key={name}
                      disabled={task.complete || task.tried.includes(`note:${i}`)}
                      onClick={() => answer(task.target, i)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              ) : (
                <p>直接点击指板上的目标位置。重复点击已找到的音不会重复计分。</p>
              )}
              <p className={`fl-feedback ${wrongCell ? 'is-wrong' : ''}`} role="status">
                {feedback || (task ? '答案已隐藏，试着凭记忆找到它。' : '')}
              </p>
            </div>
            <div className="fl-session">
              <span>
                正确 <b>{session.correct}</b>
              </span>
              <span>
                错误 <b>{session.wrong}</b>
              </span>
              <span>
                连续 <b>{session.streak}</b>
              </span>
            </div>
            <div className="fl-training-actions">
              <button
                className="fl-button"
                disabled={!task || task.complete}
                onClick={() => {
                  setTask((old) => (old ? { ...old, hinted: true } : null))
                  setFeedback('已显示提示，本题正确答案不计入掌握度。')
                }}
              >
                <Lightbulb size={17} />
                提示
              </button>
              <button
                className="fl-button"
                disabled={!task || task.complete}
                onClick={() => {
                  setSession((old) => ({ ...old, streak: 0 }))
                  startTask()
                }}
              >
                跳过
              </button>
              <button className="fl-button primary" onClick={startTask}>
                {!task ? '开始训练' : task.complete ? '下一题' : '重新出题'}
                <ArrowRight size={17} />
              </button>
            </div>
          </div>
        )}
        {progressOpen && (
          <div className="fl-weaknesses">
            <b>需要加强</b>
            {weak.length ? (
              weak.map((p) => (
                <button
                  className="fl-button"
                  key={cellId(p)}
                  onClick={() => {
                    setSelected(p)
                    patch({
                      min: Math.max(0, p.fret - 2),
                      max: Math.min(tuning.frets, p.fret + 2),
                      strings: [p.string]
                    })
                    setModule('notes')
                    setStage(-1)
                    setMode('train')
                    setProgressOpen(false)
                  }}
                >
                  {p.string} 弦 · {p.fret} 品<ArrowRight size={13} />
                </button>
              ))
            ) : (
              <span>完成更多训练后，这里会列出需要加强的位置。</span>
            )}
          </div>
        )}
        {progressOpen && (
          <div className="fl-progress-bottom">
            <p>
              {selected
                ? `${selected.string} 弦 · ${selected.fret} 品：${(() => {
                    const score = progress.cells[progressKey(tuning, selected)]
                    return score
                      ? `正确 ${score.correct} 次，错误 ${score.wrong} 次${score.correct ? `，平均 ${(score.totalMs / score.correct / 1000).toFixed(1)} 秒` : ''}`
                      : '尚无练习记录'
                  })()}`
                : '点击指板上的位置，查看你的练习记录。'}
            </p>
            <button
              className="fl-button"
              onClick={() => {
                setProgressOpen(false)
                setTask((old) => (old ? { ...old, started: performance.now() } : null))
              }}
            >
              返回{mode === 'train' ? '训练' : '探索'}
            </button>
          </div>
        )}
        {mode === 'explore' && !progressOpen && (
          <div className="fl-advice">
            <Lightbulb size={29} strokeWidth={1.3} />
            <div>
              <h2>练习建议</h2>
              <p>
                {module === 'notes'
                  ? '从记住低音弦的自然音开始，逐步扩展到全指板。'
                  : module === 'degrees'
                    ? '从 Root 出发，寻找三度与五度，建立音级的空间关系。'
                    : module === 'chords'
                      ? '沿着相邻弦组，找到同一和弦的原位与转位。'
                      : '先掌握一个把位，再寻找与相邻把位的连接音。'}
              </p>
            </div>
            <button
              className="fl-button primary"
              onClick={() => {
                setSession({ correct: 0, wrong: 0, streak: 0, seconds: 0 })
                startTask()
              }}
            >
              <Target size={23} />
              开始训练
              <ArrowRight size={20} />
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
