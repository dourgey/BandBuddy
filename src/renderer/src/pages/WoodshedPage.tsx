import { allowAudioAction, useRecordingSession } from '../recording-session.js'
import { claimAudioSession, isAudioSessionCurrent, releaseAudioSession } from '../audio-session.js'
import { Select } from '../components/ui/Select.js'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Guitar,
  Grid2X2,
  Dumbbell,
  Wrench,
  Search,
  Bookmark,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Music2,
  Compass,
  Volume2,
  Square,
  ListMusic,
  Mic,
  Timer,
  CircleHelp,
  RotateCcw,
  Drum,
  AudioLines,
  Piano
} from 'lucide-react'
import { LESSONS, TRACKS, LEVELS, BLUES_ROLES, CONTENT_SOURCES } from '../woodshed/curriculum.js'
import {
  TUNINGS,
  CIRCLE,
  SCALES,
  CHORDS,
  ROOTS,
  parseNote,
  noteName,
  mod,
  type Tuning
} from '../woodshed/theory.js'
import {
  DEFAULT_EXERCISE,
  type Preferences,
  type ExerciseConfig,
  type Lesson,
  type Section
} from '../woodshed/types.js'
import { readPreferences, savePreferences } from '../woodshed/preferences.js'
import { Workbench, SelectField, NumberField } from '../woodshed/Workbench.js'
import { PianoWorkbench } from '../woodshed/PianoWorkbench.js'
import { pianoDefaults, applyPianoPreset } from '../woodshed/piano.js'
import { CourseGuide, ChapterDepth } from '../woodshed/CourseGuide.js'
import { COURSES } from '../woodshed/course-plan.js'
import { GUITAR_PROJECTS, electricDefaults } from '../woodshed/electric.js'
import { ElectricProjects } from '../woodshed/ElectricProjects.js'
import { EnsembleWorkbench } from '../woodshed/EnsembleWorkbench.js'
import { isWorkshop, applyWorkshopPreset, ensembleDefaults, type Workshop } from '../woodshed/ensemble.js'
import { Tuner } from '../woodshed/Tuner.js'
import { WoodshedAudio } from '../woodshed/audio.js'
import '../woodshed/woodshed.css'
const NAV = [
  { id: 'learn', name: '系统学习', subtitle: '把知识连成体系', icon: BookOpen },
  { id: 'lab', name: '指板实验室', subtitle: '看见每一个音', icon: Grid2X2 },
  { id: 'practice', name: '专项练习', subtitle: '带着目标开始', icon: Dumbbell },
  { id: 'tools', name: '工具箱', subtitle: '随手打开，即刻使用', icon: Wrench }
] as const
const TOOLS = [
  { id: 'metronome', name: '节拍器', icon: Timer },
  { id: 'tuner', name: '调音器', icon: Mic },
  { id: 'chords', name: '和弦查询', icon: Music2 },
  { id: 'circle', name: '五度圈', icon: Compass },
  { id: 'drone', name: '持续参考音', icon: Volume2 },
  { id: 'drums', name: '鼓手节奏', icon: Drum },
  { id: 'violin', name: '小提琴工具', icon: Music2 },
  { id: 'synthesis', name: '合成器实验', icon: AudioLines },
  { id: 'piano', name: '键盘／钢琴', icon: Piano }
] as const
export default function WoodshedPage({
  active = true,
  outputDeviceId = '',
  onToast
}: {
  active?: boolean
  outputDeviceId?: string
  onToast: (message: string) => void
}): React.JSX.Element {
  const [smallViewport, setSmallViewport] = useState(() => window.innerWidth <= 1000 || window.innerHeight <= 600)
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(() => {
    try { const saved = localStorage.getItem('bandbuddy.woodshed.sidebarExpanded'); return saved === 'true' ? true : saved === 'false' ? false : null } catch { return null }
  })
  const sidebarExpanded = sidebarPreference ?? !smallViewport
  useEffect(() => {
    const resize = (): void => setSmallViewport(window.innerWidth <= 1000 || window.innerHeight <= 600)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const [p, setP] = useState<Preferences>(readPreferences),
    [audio, setAudio] = useState<WoodshedAudio | null>(null)
  const [query, setQuery] = useState(''),
    [track, setTrack] = useState('all'),
    [level, setLevel] = useState('all'),
    [electricCategory, setElectricCategory] = useState('all'),
    [onlyFavorites, setOnlyFavorites] = useState(false)
  const [tool, setTool] = useState('metronome'),
    [customOpen, setCustomOpen] = useState(false),
    [customText, setCustomText] = useState(''),
    [customError, setCustomError] = useState(''),
    [drone, setDrone] = useState(false)
  const scroll = useRef<HTMLDivElement>(null),
    storageFailed = useRef(false)
  const droneSession = useRef<number | undefined>(undefined)
  const releaseDrone = (): void => { if (droneSession.current !== undefined) releaseAudioSession('woodshed', droneSession.current) }
  const recording = useRecordingSession()
  useEffect(() => { if (recording) { audio?.stop(); setDrone(false); releaseDrone() } }, [Boolean(recording), audio])
  const latest = useRef(p)
  latest.current = p
  const scrollPositions = useRef({ ...p.scrollPositions }),
    scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistScroll = useCallback(() => {
    savePreferences({ ...latest.current, scrollPositions: scrollPositions.current })
  }, [])
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scrollPositions.current[p.section]
  }, [p.section])
  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      persistScroll()
    },
    [persistScroll]
  )
  const toast = useRef(onToast)
  toast.current = onToast
  const error = useCallback((message: string) => toast.current(message), [])
  const patch = useCallback(
    (value: Partial<ExerciseConfig>) => setP((old) => ({ ...old, exercise: { ...old.exercise, ...value } })),
    []
  )
  const labels = useCallback((value: Preferences['labels']) => setP((old) => ({ ...old, labels: value })), [])
  useEffect(() => {
    const engine = new WoodshedAudio()
    setAudio(engine)
    return () => { engine.destroy(); releaseDrone() }
  }, [])
  useEffect(() => {
    void audio
      ?.setOutput(outputDeviceId)
      .catch((e) => error(`无法切换练功房输出：${e instanceof Error ? e.message : String(e)}`))
  }, [audio, outputDeviceId, error])
  useEffect(() => { audio?.setVisualActive(active) }, [audio, active])
  useEffect(() => {
    audio?.setReference(p.a4)
  }, [audio, p.a4])
  useEffect(() => {
    if (!savePreferences({ ...p, scrollPositions: scrollPositions.current }) && !storageFailed.current) {
      storageFailed.current = true
      error('本地存储不可用，本次设置无法在重启后恢复。')
    }
  }, [p, error])
  useEffect(() => {
    audio?.stop()
    setDrone(false)
    releaseDrone()
  }, [p.section, tool, audio])
  useEffect(() => {
    if (drone) {
      audio?.stop()
      setDrone(false)
      releaseDrone()
    }
  }, [p.exercise.root, p.a4, p.droneFifth])
  const preset = TUNINGS.find((t) => t.id === p.tuningId)!
  const tuning = useMemo<Tuning>(
    () =>
      p.customNotes
        ? { ...preset, id: `${preset.id}-custom`, name: `${preset.name} · 自定义`, notes: p.customNotes }
        : preset,
    [preset, p.customNotes]
  )
  const lesson = LESSONS.find((l) => l.id === p.lessonId) ?? LESSONS[0]!
  const visible = useMemo(
    () =>
      LESSONS.filter(
        (l) =>
          (track === 'all' || l.track === track) &&
          (track !== 'electric' || electricCategory === 'all' || l.category === electricCategory) &&
          (level === 'all' || String(l.level) === level) &&
          (!onlyFavorites || p.favorites.includes(l.id)) &&
          `${l.title} ${l.category} ${l.goal} ${l.explanation}`
            .toLowerCase()
            .includes(query.trim().toLowerCase())
      ),
    [track, level, onlyFavorites, p.favorites, query, electricCategory]
  )
  const selectLesson = (next: Lesson): void => {
    audio?.stop()
    if (isWorkshop(next.track)) setCustomOpen(false)
    const target =
      isWorkshop(next.track) ||
      next.track === 'shared' ||
      next.track === 'blues' ||
      next.track === preset.instrument ||
      (next.track === 'electric' && preset.instrument === 'guitar')
        ? p.tuningId
        : next.track === 'guitar' || next.track === 'electric'
          ? 'guitar'
          : next.track === 'bass'
            ? 'bass'
            : 'uke-high'
    const targetPreset = TUNINGS.find((t) => t.id === target)!
    setP((old) => ({
      ...old,
      lessonId: next.id,
      electric: next.track === 'electric' ? { stage: next.guitarStage ?? 0, shift: 0 } : old.electric,
      piano: next.track === 'piano' ? applyPianoPreset(old.piano, next.workshopPreset ?? '') : old.piano,
      ensemble:
        isWorkshop(next.track) && next.track !== 'piano'
          ? applyWorkshopPreset(old.ensemble, next.track, next.workshopPreset ?? '')
          : old.ensemble,
      tuningId: target,
      customNotes: target !== old.tuningId ? null : old.customNotes,
      capo: target !== old.tuningId ? 0 : old.capo,
      exercise: {
        ...DEFAULT_EXERCISE,
        ...next.exercise,
        chord:
          next.exercise.chord ??
          (next.track === 'blues'
            ? '7'
            : SCALES[next.exercise.scale ?? 'major']!.semitones.includes(3)
              ? 'minor'
              : 'major'),
        bass: targetPreset.instrument === 'bass' ? 0 : DEFAULT_EXERCISE.bass,
        minFret: Math.min(
          next.exercise.minFret ?? 0,
          targetPreset.frets - (target === old.tuningId ? old.capo : 0)
        ),
        maxFret: Math.min(
          targetPreset.frets - (target === old.tuningId ? old.capo : 0),
          next.exercise.maxFret ?? 5
        )
      }
    }))
  }
  const selectInstrument = (id: string): void => {
    audio?.stop()
    if (isWorkshop(id)) {
      selectLesson(LESSONS.find((l) => l.track === id)!)
      setTrack(id)
      if (p.section === 'tools') setTool(id)
      setCustomOpen(false)
      return
    }
    const next = TUNINGS.find((t) => t.id === id)!
    setTrack(lesson.track === 'electric' && next.instrument === 'guitar' ? 'electric' : next.instrument)
    const nextLesson =
      lesson.track === 'shared' ||
      lesson.track === 'blues' ||
      lesson.track === next.instrument ||
      (lesson.track === 'electric' && next.instrument === 'guitar')
        ? lesson
        : LESSONS.find((l) => l.track === next.instrument)!
    setP((old) => ({
      ...old,
      tuningId: id,
      customNotes: null,
      capo: 0,
      lessonId: nextLesson.id,
      exercise: {
        ...(nextLesson.id === lesson.id ? old.exercise : { ...DEFAULT_EXERCISE, ...nextLesson.exercise }),
        strings: [],
        minFret: 0,
        maxFret: 5,
        bass: next.instrument === 'bass' ? 0 : 0.25
      }
    }))
    setCustomOpen(false)
  }
  const navigate = (section: Section): void => {
    setP((old) => ({ ...old, section }))
  }
  const favorite = (id: string): void =>
    setP((old) => ({
      ...old,
      favorites: old.favorites.includes(id) ? old.favorites.filter((x) => x !== id) : [...old.favorites, id]
    }))
  const applyCustom = (): void => {
    const parts = customText.trim().split(/[\s,，]+/)
    const notes = parts.map(parseNote)
    if (notes.length !== preset.notes.length || notes.some((n) => n === null)) {
      setCustomError(
        `请输入 ${preset.notes.length} 个含八度的音名，例如 ${preset.notes.map((n) => noteName(n)).join(' ')}。`
      )
      return
    }
    setP((old) => ({ ...old, customNotes: notes as number[] }))
    setCustomError('')
    setCustomOpen(false)
  }
  const openPractice = (): void => {
    navigate('practice')
    scroll.current?.scrollTo(0, 0)
  }
  const renderEnsemble = (kind: Workshop): React.JSX.Element =>
    kind === 'piano' ? (
      <PianoWorkbench
        visible={active}
        key={`${p.section}-${lesson.id}-${tool}`}
        config={p.piano}
        onChange={(piano) => setP((old) => ({ ...old, piano }))}
        outputDeviceId={outputDeviceId}
        a4={p.a4}
        onError={error}
      />
    ) : (
      <EnsembleWorkbench
        visible={active}
        key={`${p.section}-${kind}-${lesson.id}-${tool}`}
        kind={kind}
        p={p}
        onChange={(value) => setP((old) => ({ ...old, ...value }))}
        audio={audio}
        outputDeviceId={outputDeviceId}
        onError={error}
      />
    )
  const renderWorkbench = (metronomeOnly = false): React.JSX.Element =>
    !metronomeOnly && p.section !== 'tools' && isWorkshop(lesson.track) ? (
      renderEnsemble(lesson.track)
    ) : (
      <Workbench
        visible={active}
        tuning={tuning}
        preferences={p}
        patch={patch}
        onLabels={labels}
        audio={audio}
        onError={error}
        technique={p.section === 'learn' || p.section === 'practice' ? lesson.technique : undefined}
        project={
          !metronomeOnly && (p.section === 'learn' || p.section === 'practice')
            ? GUITAR_PROJECTS.find((project) => project.id === lesson.guitarProjectId)
            : undefined
        }
        onProjectSettings={(electric) =>
          setP((old) => ({ ...old, electric, exercise: { ...old.exercise, loopStart: 1, loopEnd: 0 } }))
        }
        metronomeOnly={metronomeOnly}
      />
    )
  return (
    <main className={`ws-page ${sidebarExpanded ? '' : 'is-sidebar-collapsed'}`}>
      <aside className="ws-sidebar" aria-hidden={!sidebarExpanded} inert={!sidebarExpanded} id="woodshed-navigation">
        <div className="ws-sidebar-brand">
          <div className="ws-brand-icon">
            <Guitar size={23} />
          </div>
          <div>
            <h1>练功房</h1>
            <span>THE WOODSHED</span>
          </div>
        </div>
        <nav aria-label="练功房导航">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={p.section === item.id ? 'selected' : ''}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>
                <b>{item.id === 'lab' && isWorkshop(lesson.track) ? '乐器实验台' : item.name}</b>
                <small>
                  {item.id === 'lab' && isWorkshop(lesson.track) ? '听见变化与联系' : item.subtitle}
                </small>
              </span>
              {p.section === item.id && <ChevronRight size={15} />}
            </button>
          ))}
        </nav>
        <div className="ws-sidebar-divider" />
        <button
          className={`ws-favorites-nav ${onlyFavorites ? 'selected' : ''}`}
          onClick={() => {
            setOnlyFavorites((v) => !v)
            navigate('learn')
          }}
        >
          <Bookmark size={17} />
          <span>我的收藏</span>
          <b>{p.favorites.length}</b>
        </button>
        <div className="ws-sidebar-note">
          <span className="ws-eyebrow">PRACTICE WITH PURPOSE</span>
          <h3>
            慢一点，
            <br />
            听清每个音。
          </h3>
          <p>
            一次专注一个目标。
            <br />
            在理解之后练习，
            <br />
            在音乐之中应用。
          </p>
          <div className="ws-string-decoration">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <i key={n} />
            ))}
          </div>
        </div>
        <div className="ws-local">
          <span /> 本地可用 · 自由练习
        </div>
      </aside>
      <section className="ws-main">
        <header className="ws-topbar">
          <button className="ws-button ws-sidebar-toggle" aria-label={`${sidebarExpanded ? '收起' : '展开'}练功房目录`} aria-expanded={sidebarExpanded} aria-controls="woodshed-navigation" onClick={() => { const next = !sidebarExpanded; setSidebarPreference(next); try { localStorage.setItem('bandbuddy.woodshed.sidebarExpanded', String(next)) } catch { /* Keep the layout usable if storage is unavailable. */ } }}>{sidebarExpanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}目录</button>
          <div className="ws-breadcrumb">
            练功房 <ChevronRight size={13} />{' '}
            <b>
              {p.section === 'lab' && isWorkshop(lesson.track)
                ? '乐器实验台'
                : NAV.find((n) => n.id === p.section)?.name}
            </b>
          </div>
          <div className="ws-instrument-controls">
            {lesson.track === 'piano' ? (
              <Piano size={16} />
            ) : lesson.track === 'drums' ? (
              <Drum size={16} />
            ) : lesson.track === 'synthesis' ? (
              <AudioLines size={16} />
            ) : lesson.track === 'violin' ? (
              <Music2 size={16} />
            ) : (
              <Guitar size={16} />
            )}
            <Select
              aria-label="乐器与调弦"
              value={isWorkshop(lesson.track) ? lesson.track : p.tuningId}
              onChange={(e) => selectInstrument(e.target.value)}
            >
              {(['piano', 'drums', 'violin', 'synthesis'] as const).map((id) => (
                <option value={id} key={id}>
                  {TRACKS[id]}
                </option>
              ))}
              {TUNINGS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <button
              disabled={isWorkshop(lesson.track)}
              className={`ws-button ${p.customNotes ? 'active' : ''}`}
              onClick={() => {
                setCustomText(tuning.notes.map((n) => noteName(n)).join(' '))
                setCustomError('')
                setCustomOpen((v) => !v)
              }}
            >
              调弦与显示
            </button>
          </div>
        </header>
        {customOpen && (
          <div className="ws-custom-panel">
            <label>
              自定义空弦（从第 {preset.notes.length} 弦到第 1 弦，必须含八度）
              <input
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder={preset.notes.map((n) => noteName(n)).join(' ')}
              />
            </label>
            <button className="ws-button primary" onClick={applyCustom}>
              应用调弦
            </button>
            <button
              className="ws-button"
              onClick={() => {
                setP((old) => ({ ...old, customNotes: null }))
                setCustomText(preset.notes.map((n) => noteName(n)).join(' '))
                setCustomError('')
              }}
            >
              恢复预设
            </button>
            <NumberField
              label="变调夹品位"
              value={p.capo}
              min={0}
              max={12}
              onChange={(capo) =>
                setP((old) => ({
                  ...old,
                  capo,
                  exercise: { ...old.exercise, minFret: 0, maxFret: Math.min(5, tuning.frets - capo) }
                }))
              }
            />
            <label className="ws-check">
              <input
                type="checkbox"
                checked={p.leftHanded}
                onChange={(e) => setP((old) => ({ ...old, leftHanded: e.target.checked }))}
              />
              左手显示
            </label>
            {customError && (
              <p role="alert" className="ws-error">
                {customError}
              </p>
            )}
          </div>
        )}
        <div
          className="ws-scroll"
          ref={scroll}
          onScroll={(e) => {
            scrollPositions.current[p.section] = e.currentTarget.scrollTop
            if (scrollTimer.current) clearTimeout(scrollTimer.current)
            scrollTimer.current = setTimeout(persistScroll, 200)
          }}
        >
          <div className="ws-hero">
            <div>
              <span className="ws-eyebrow">
                {p.section === 'learn'
                  ? 'LEARN THE WHY. PLAY THE HOW.'
                  : p.section === 'lab'
                    ? 'A MAP FOR YOUR MUSIC.'
                    : p.section === 'practice'
                      ? 'SMALL STEPS. REAL PROGRESS.'
                      : 'READY WHEN YOU ARE.'}
              </span>
              <h2>
                {p.section === 'learn'
                  ? '把知识，变成音乐。'
                  : p.section === 'lab'
                    ? isWorkshop(lesson.track)
                      ? '从声音出发，探索音乐。'
                      : '在指板上，找到音乐。'
                    : p.section === 'practice'
                      ? '每一次练习，都有方向。'
                      : '小工具，随手就好。'}
              </h2>
              <p>
                {p.section === 'learn'
                  ? '从第一个清晰的音，到有表达的乐句。循序渐进，也可以随时探索。'
                  : p.section === 'lab'
                    ? isWorkshop(lesson.track)
                      ? '节奏、音高与音色，在听与练之间建立联系。'
                      : '音名、音级、和弦与把位，在同一张指板上建立联系。'
                    : p.section === 'practice'
                      ? '选一个目标，慢速听示范，再把它放进真实的节奏与和声。'
                      : '调准音、稳住拍点，让注意力回到演奏本身。'}
              </p>
            </div>
            <div className="ws-hero-stat">
              <b>
                {p.section === 'learn'
                  ? LESSONS.length
                  : p.section === 'tools'
                    ? TOOLS.length
                    : lesson.track === 'drums'
                      ? '4/4'
                      : '12'}
              </b>
              <span>
                {p.section === 'learn'
                  ? '学习单元'
                  : p.section === 'tools'
                    ? '常用工具'
                    : lesson.track === 'drums'
                      ? '拍点 · 自由探索'
                      : '个调 · 自由探索'}
              </span>
            </div>
          </div>
          {p.section === 'learn' && (
            <>
              <div className="ws-learning-filters">
                <div className="ws-track-tabs">
                  {[['all', '全部路线'], ...Object.entries(TRACKS)].map(([id, name]) => (
                    <button key={id} aria-pressed={track === id} onClick={() => setTrack(id!)}>
                      {name}
                      {id === 'blues' && <i />}
                    </button>
                  ))}
                </div>
                <div className="ws-search-row">
                  <label className="ws-search">
                    <Search size={16} />
                    <input
                      aria-label="搜索知识"
                      placeholder="搜索知识、技法或练习目标…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <Select aria-label="难度筛选" value={level} onChange={(e) => setLevel(e.target.value)}>
                    <option value="all">全部难度</option>
                    {Object.entries(LEVELS).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </Select>
                  <button
                    className="ws-button"
                    aria-pressed={onlyFavorites}
                    onClick={() => setOnlyFavorites((v) => !v)}
                  >
                    <Bookmark size={14} />
                    {onlyFavorites ? '仅看收藏' : '收藏筛选'}
                  </button>
                </div>
              </div>
              {track === 'electric' && (
                <div className="ws-electric-filter">
                  <span>风格与能力</span>
                  <div className="ws-segments">
                    {['all', '硬摇', '朋克', '后摇', '数摇', '机能项目'].map((category) => (
                      <button
                        key={category}
                        aria-pressed={electricCategory === category}
                        onClick={() => setElectricCategory(category)}
                      >
                        {category === 'all' ? '全部' : category}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <CourseGuide
                track={track in COURSES ? (track as Lesson['track']) : lesson.track}
                lessons={LESSONS}
                onSelect={(next) => {
                  selectLesson(next)
                  setTrack(next.track)
                  setQuery('')
                  setLevel('all')
                  setOnlyFavorites(false)
                  setElectricCategory('all')
                }}
              />
              {(track === 'electric' || (track === 'all' && lesson.track === 'electric')) && (
                <ElectricProjects
                  lessons={LESSONS}
                  onSelect={(next) => {
                    selectLesson(next)
                    setTrack('electric')
                    setElectricCategory('all')
                    setQuery('')
                    setLevel('all')
                    setOnlyFavorites(false)
                  }}
                />
              )}
              <div className="ws-learn-layout">
                <aside className="ws-lesson-list">
                  <div className="ws-list-heading">
                    <span>{onlyFavorites ? '我的收藏' : '学习目录'}</span>
                    <small>{visible.length} 个单元</small>
                  </div>
                  {visible.map((item, i) => (
                    <button
                      key={item.id}
                      className={`ws-lesson-item ${item.id === lesson.id ? 'selected' : ''}`}
                      onClick={() => selectLesson(item)}
                    >
                      <span className="ws-lesson-number">{String(i + 1).padStart(2, '0')}</span>
                      <span>
                        <small>
                          {TRACKS[item.track]} · {item.category}
                        </small>
                        <b>{item.title}</b>
                        <em>{LEVELS[item.level]}</em>
                      </span>
                      {p.favorites.includes(item.id) && <Bookmark size={12} fill="currentColor" />}
                    </button>
                  ))}
                  {!visible.length && (
                    <div className="ws-empty">
                      <Search size={24} />
                      <p>没有匹配的学习单元。</p>
                      <button
                        className="ws-button"
                        onClick={() => {
                          setQuery('')
                          setTrack('all')
                          setLevel('all')
                          setOnlyFavorites(false)
                        }}
                      >
                        清除筛选
                      </button>
                    </div>
                  )}
                </aside>
                <article className="ws-lesson-detail">
                  <div className="ws-lesson-meta">
                    <span className="ws-tag">{TRACKS[lesson.track]}</span>
                    <span>{lesson.category}</span>
                    <span>·</span>
                    <span>{LEVELS[lesson.level]}</span>
                    <button
                      aria-label={p.favorites.includes(lesson.id) ? '取消收藏' : '收藏本单元'}
                      aria-pressed={p.favorites.includes(lesson.id)}
                      onClick={() => favorite(lesson.id)}
                    >
                      <Bookmark size={19} fill={p.favorites.includes(lesson.id) ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                  <h2>{lesson.title}</h2>
                  <p className="ws-lesson-goal">{lesson.goal}</p>
                  <div className="ws-prerequisites">
                    <span>先了解</span>
                    {lesson.prerequisites.length ? (
                      lesson.prerequisites.map((id) => (
                        <button key={id} onClick={() => selectLesson(LESSONS.find((l) => l.id === id)!)}>
                          {LESSONS.find((l) => l.id === id)?.title}
                          <ChevronRight size={12} />
                        </button>
                      ))
                    ) : (
                      <small>无需前置知识，从这里开始。</small>
                    )}
                  </div>
                  <h3>理解它</h3>
                  <p>{lesson.explanation}</p>
                  <div className="ws-example">
                    <span>举个例子</span>
                    <p>{lesson.example}</p>
                  </div>
                  <h3>动手练习</h3>
                  <ol className="ws-steps">
                    {lesson.steps.map((step, i) => (
                      <li key={i}>
                        <span>{i + 1}</span>
                        <p>{step}</p>
                      </li>
                    ))}
                  </ol>
                  {lesson.track === 'blues' && (
                    <div className="ws-blues-role">
                      <Guitar size={19} />
                      <p>{BLUES_ROLES[tuning.instrument]}</p>
                    </div>
                  )}
                  <div className="ws-lesson-checks">
                    <div>
                      <h4>留意这些问题</h4>
                      <p>{lesson.mistakes}</p>
                    </div>
                    <div>
                      <h4>如何自检</h4>
                      <p>{lesson.check}</p>
                    </div>
                  </div>
                  <div className="ws-difficulty">
                    <div>
                      <small>降低难度</small>
                      <p>{lesson.easier}</p>
                    </div>
                    <div>
                      <small>下一步挑战</small>
                      <p>{lesson.harder}</p>
                    </div>
                  </div>
                  <ChapterDepth lesson={lesson} />
                  <div className="ws-lesson-actions">
                    <button className="ws-button primary" onClick={openPractice}>
                      <PlayIcon />
                      进入专项练习
                      <ArrowRight size={15} />
                    </button>
                    <button className="ws-button" onClick={() => navigate('lab')}>
                      {isWorkshop(lesson.track) ? '在实验台中探索' : '在指板中探索'}
                    </button>
                  </div>
                  {lesson.related.length > 0 && (
                    <div className="ws-related">
                      <small>继续探索</small>
                      {lesson.related.map((id) => (
                        <button key={id} onClick={() => selectLesson(LESSONS.find((l) => l.id === id)!)}>
                          {LESSONS.find((l) => l.id === id)?.title}
                          <ArrowRight size={13} />
                        </button>
                      ))}
                    </div>
                  )}
                  <details className="ws-source-note">
                    <summary>内容与谱例说明</summary>
                    <p>
                      {lesson.track === 'electric'
                        ? '电吉他项目按标准调弦编写，每个版本有原创谱例。参考《365》与《地狱训练》的技能分类及拆解到综合的编排思路，不复刻书中谱例，也不使用每日任务。'
                        : '讲解与短谱例为原创练习材料。谱面下方为可调音型，文字中的专项步骤需结合实际演奏；听准与弹准分别自检，不自动评分。'}
                    </p>
                    <p>
                      知识入口按前置关系组织，不限制自由浏览。资料用于核对基础概念，讲解与练习为原创；外部参考需联网，学习正文离线可用。
                      {CONTENT_SOURCES.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.label} ↗{' '}
                        </a>
                      ))}
                    </p>
                  </details>
                </article>
              </div>
              <div className="ws-section-caption">
                <span>
                  {isWorkshop(lesson.track) ? '把刚学到的，变成听得见的练习' : '把刚学到的，放到指板上'}
                </span>
                <small>
                  {lesson.track === 'electric'
                    ? '原创项目谱例 · 拆解 → 组合 → 应用'
                    : '所选单元的参考音型 · 可自由调整'}
                </small>
              </div>
              {renderWorkbench()}
            </>
          )}
          {p.section === 'lab' && (
            <>
              <div className="ws-lab-intro">
                <Compass size={25} />
                <div>
                  <b>
                    {isWorkshop(lesson.track)
                      ? `${TRACKS[lesson.track]} · 交互实验`
                      : '一张指板，多种观察方式'}
                  </b>
                  <p>
                    {isWorkshop(lesson.track)
                      ? '从节奏、音高或音色出发，每次只改变一个变量，听清它的作用。上方可切换练习乐器。'
                      : '选择音阶或和弦，点击音符试听；限定弦组与品位后，直接生成对应音型。左手显示只镜像空间，弦号和音高保持一致。'}
                  </p>
                </div>
                <button className="ws-button" onClick={() => navigate('practice')}>
                  生成专项练习
                  <ArrowRight size={14} />
                </button>
              </div>
              {renderWorkbench()}
            </>
          )}
          {p.section === 'practice' && (
            <>
              <div className="ws-practice-selection">
                <SelectField
                  label="练习目标"
                  value={lesson.id}
                  options={Object.fromEntries(
                    LESSONS.filter((l) =>
                      isWorkshop(lesson.track)
                        ? l.track === lesson.track
                        : l.track === 'shared' ||
                          l.track === 'blues' ||
                          l.track === tuning.instrument ||
                          (l.track === 'electric' && tuning.instrument === 'guitar')
                    ).map((l) => [l.id, `${TRACKS[l.track]} · ${l.title}`])
                  )}
                  onChange={(id) => selectLesson(LESSONS.find((l) => l.id === id)!)}
                />
                <button
                  className="ws-icon-button"
                  aria-label="收藏当前练习"
                  onClick={() => favorite(lesson.id)}
                >
                  <Bookmark size={18} fill={p.favorites.includes(lesson.id) ? 'currentColor' : 'none'} />
                </button>
                <button className="ws-button" onClick={() => navigate('learn')}>
                  <BookOpen size={15} />
                  查看讲解
                </button>
              </div>
              {lesson.track === 'electric' && <ElectricProjects lessons={LESSONS} onSelect={selectLesson} />}
              <div className="ws-goal-callout">
                <span>本次只关注</span>
                <b>{lesson.goal}</b>
                <p>{lesson.check}</p>
                {lesson.track === 'blues' && <small>{BLUES_ROLES[tuning.instrument]}</small>}
              </div>
              {renderWorkbench()}
            </>
          )}
          {p.section === 'tools' && (
            <>
              <div className="ws-tool-tabs">
                {TOOLS.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={tool === item.id}
                    onClick={() => {
                      setTool(item.id)
                      if (item.id === 'chords') patch({ material: 'chord', pattern: 'chord' })
                    }}
                  >
                    <item.icon size={20} />
                    <span>{item.name}</span>
                  </button>
                ))}
              </div>
              {isWorkshop(tool) && renderEnsemble(tool)}
              {tool === 'metronome' && renderWorkbench(true)}
              {tool === 'tuner' && (
                <Tuner
                  visible={active}
                  tuning={lesson.track === 'violin' ? { id: 'violin', notes: [55, 62, 69, 76] } : tuning}
                  capo={lesson.track === 'violin' ? 0 : p.capo}
                  a4={p.a4}
                  onA4={(a4) => setP((old) => ({ ...old, a4 }))}
                  inputDevice={p.inputDevice}
                  onDevice={(inputDevice) => setP((old) => ({ ...old, inputDevice }))}
                  audio={audio}
                  onError={error}
                />
              )}
              {tool === 'chords' && renderWorkbench()}
              {tool === 'circle' && (
                <section className="ws-tool-panel">
                  <div className="ws-panel-heading">
                    <div>
                      <small>KEYS & RELATIONSHIPS</small>
                      <h2>五度圈</h2>
                    </div>
                    <span className="ws-tag">顺时针上行纯五度</span>
                  </div>
                  <div className="ws-circle-layout">
                    <svg viewBox="0 0 440 440" role="group" aria-label="交互五度圈">
                      <circle cx="220" cy="220" r="157" fill="none" stroke="var(--border-strong)" strokeWidth="44" />
                      <circle cx="220" cy="220" r="98" fill="none" stroke="var(--border)" />
                      <text x="220" y="211" textAnchor="middle" fill="var(--ink)" fontSize="27">
                        {ROOTS[p.exercise.root]}
                      </text>
                      <text x="220" y="238" textAnchor="middle" fill="var(--muted)" fontSize="12">
                        大调 · 调性中心
                      </text>
                      {CIRCLE.map(([major, minor, signature], i) => {
                        const angle = ((i * 30 - 90) * Math.PI) / 180,
                          x = 220 + 157 * Math.cos(angle),
                          y = 220 + 157 * Math.sin(angle)
                        const pc = mod(parseNote(`${major}4`)!)
                        return (
                          <g
                            key={major}
                            role="button"
                            tabIndex={0}
                            aria-label={`${major}大调，${minor}，${signature}`}
                            onClick={() => patch({ root: pc, scale: 'major' })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') patch({ root: pc, scale: 'major' })
                            }}
                            className="ws-circle-key"
                          >
                            <circle
                              cx={x}
                              cy={y}
                              r="27"
                              fill={p.exercise.root === pc ? 'var(--accent)' : 'var(--surface-raised)'}
                              stroke="var(--border)"
                            />
                            <text
                              x={x}
                              y={y + 5}
                              textAnchor="middle"
                              fill={p.exercise.root === pc ? 'var(--on-accent)' : 'var(--ink)'}
                              fontSize="16"
                              fontWeight="600"
                            >
                              {major}
                            </text>
                            <text
                              x={220 + 111 * Math.cos(angle)}
                              y={224 + 111 * Math.sin(angle)}
                              textAnchor="middle"
                              fill="var(--muted)"
                              fontSize="11"
                            >
                              {minor}
                            </text>
                          </g>
                        )
                      })}
                    </svg>
                    <div>
                      <h3>{ROOTS[p.exercise.root]} 大调</h3>
                      <p>
                        {CIRCLE.find(([root]) => mod(parseNote(`${root}4`)!) === p.exercise.root)?.[2]} ·
                        关系小调{' '}
                        {CIRCLE.find(([root]) => mod(parseNote(`${root}4`)!) === p.exercise.root)?.[1]}
                      </p>
                      <p>
                        外圈为大调，内圈为关系小调。相邻调共享六个自然调式音，调号相差一个升降号。关系大小调共用调号，但主音与和声中心不同。
                      </p>
                      <h4>调内三和弦</h4>
                      <div className="ws-diatonic-chords">
                        {SCALES.major!.semitones.map((n, i) => (
                          <button
                            key={i}
                            onClick={() => {
                              patch({
                                root: mod(p.exercise.root + n),
                                chord: i === 6 ? 'dim' : [1, 2, 5].includes(i) ? 'minor' : 'major',
                                material: 'chord',
                                pattern: 'chord'
                              })
                              setTool('chords')
                            }}
                          >
                            <small>{['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'][i]}</small>
                            <b>
                              {ROOTS[mod(p.exercise.root + n)]}
                              {i === 6 ? 'dim' : [1, 2, 5].includes(i) ? 'm' : ''}
                            </b>
                          </button>
                        ))}
                      </div>
                      <button
                        className="ws-button primary"
                        onClick={() => {
                          patch({ scale: 'major', material: 'scale', pattern: 'scale' })
                          navigate('lab')
                        }}
                      >
                        在指板中打开
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </div>
                </section>
              )}
              {tool === 'drone' && (
                <section className="ws-tool-panel ws-drone">
                  <div className="ws-panel-heading">
                    <div>
                      <small>FIND YOUR TONAL CENTER</small>
                      <h2>持续参考音</h2>
                    </div>
                    <Volume2 size={24} />
                  </div>
                  <div className={`ws-drone-orbit ${drone ? 'playing' : ''}`}>
                    <span>
                      {ROOTS[p.exercise.root]}
                      <small>{p.droneFifth ? '+ 纯五度' : '根音'}</small>
                    </span>
                  </div>
                  <div className="ws-form-row">
                    <SelectField
                      label="参考音主音"
                      value={p.exercise.root}
                      options={Object.fromEntries(ROOTS.map((n, i) => [i, n]))}
                      onChange={(v) => patch({ root: Number(v) })}
                    />
                    <label className="ws-check">
                      <input
                        type="checkbox"
                        checked={p.droneFifth}
                        onChange={(e) => setP((old) => ({ ...old, droneFifth: e.target.checked }))}
                      />
                      加入纯五度
                    </label>
                    <NumberField
                      label="A4 标准音"
                      value={p.a4}
                      min={430}
                      max={450}
                      onChange={(a4) => setP((old) => ({ ...old, a4 }))}
                    />
                  </div>
                  <button
                    className="ws-button primary"
                    disabled={!audio}
                    onClick={() => {
                      if (drone) {
                        audio?.stop()
                        setDrone(false)
                        releaseDrone()
                      } else {
                        if (!allowAudioAction()) return
                        const id = claimAudioSession('woodshed', '持续参考音', () => { audio?.stop(); setDrone(false); releaseDrone() })
                        droneSession.current = id
                        void audio
                          ?.drone(p.exercise.root, p.droneFifth)
                          .then(() => { if (isAudioSessionCurrent(id)) setDrone(true) })
                          .catch((e) => { releaseAudioSession('woodshed', id); error(String(e)) })
                      }
                    }}
                  >
                    {drone ? <Square size={17} /> : <Volume2 size={17} />}{' '}
                    {drone ? '停止参考音' : '播放参考音'}
                  </button>
                  <p>
                    保持一个调性中心，慢弹音阶并听各音与根音的距离。比较同主音大小调或调式时保持 Drone 不变。
                  </p>
                </section>
              )}
            </>
          )}
          <footer className="ws-footer">
            <CircleHelp size={14} />
            <span>理解 → 听见 → 找到 → 演奏。按自己的节奏探索。</span>
            <button
              onClick={() => {
                audio?.stop()
                setP((old) => ({
                  ...old,
                  piano: pianoDefaults(),
                  electric: electricDefaults(),
                  ensemble: ensembleDefaults(),
                  exercise: { ...DEFAULT_EXERCISE, bass: tuning.instrument === 'bass' ? 0 : 0.25 }
                }))
              }}
            >
              <RotateCcw size={12} />
              重置练习参数
            </button>
          </footer>
        </div>
      </section>
    </main>
  )
}
function PlayIcon(): React.JSX.Element {
  return <ListMusic size={16} />
}
