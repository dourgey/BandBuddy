import { lazy, Suspense } from 'react'
import { FretboardLab } from '../woodshed/FretboardLab.js'
import { DrumMachine as SampleDrumMachine } from '../sample-drums/DrumMachine.js'
const InstrumentWorkshopPage = lazy(() => import('./InstrumentWorkshopPage.js'))
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Guitar,
  Grid2X2,
  Dumbbell,
  Wrench,
  ArrowRight,
  ChevronRight,
  Music2,
  Compass,
  Volume2,
  Square,
  Mic,
  Timer,
  CircleHelp,
  RotateCcw,
  Drum,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import { LESSONS } from '../woodshed/curriculum.js'
import { TUNINGS, SCALES, CHORDS, ROOTS, parseNote, noteName, type Tuning } from '../woodshed/theory.js'
import {
  DEFAULT_EXERCISE,
  type Preferences,
  type ExerciseConfig,
  type Section
} from '../woodshed/types.js'
import { readPreferences, savePreferences } from '../woodshed/preferences.js'
import { Workbench, SelectField, NumberField } from '../woodshed/Workbench.js'
import { HarmonyExplorer } from '../woodshed/HarmonyExplorer.js'
import { ChordLookup } from '../woodshed/ChordLookup.js'
import { Tuner } from '../woodshed/Tuner.js'
import { SelectMenu } from '../components/SelectMenu.js'
import { DrumMachine } from '../woodshed/DrumMachine.js'
import { Metronome } from '../woodshed/Metronome.js'
import { WoodshedAudio } from '../woodshed/audio.js'
import '../woodshed/woodshed.css'
import { Learning, LearningBreadcrumb, type LearningLocation } from '../woodshed/Learning.js'
import { Practice, PracticeBreadcrumb } from '../woodshed/Practice.js'
import type { PracticeLocation } from '../woodshed/practice-curriculum.js'
const NAV = [
  { id: 'learn', name: '系统学习', icon: BookOpen },
  { id: 'lab', name: '指板实验室', icon: Grid2X2 },
  { id: 'practice', name: '专项练习', icon: Dumbbell },
  { id: 'tools', name: '工具箱', icon: Wrench }
] as const
const TOOLS = [
  { id: 'metronome', name: '节拍器', icon: Timer },
  { id: 'tuner', name: '调音器', icon: Mic },
  { id: 'drums', name: '鼓机', icon: Drum },
  { id: 'sample-drums', name: '采样鼓机', icon: Drum },
  { id: 'workshop', name: '演奏工作台', icon: Guitar },
  { id: 'chords', name: '和弦查询', icon: Music2 },
  { id: 'circle', name: '五度圈', icon: Compass },
  { id: 'drone', name: '持续参考音', icon: Volume2 }
] as const
export default function WoodshedPage({
  outputDeviceId = '',
  onToast
}: {
  active?: boolean
  outputDeviceId?: string
  onToast: (message: string) => void
}): React.JSX.Element {
  const [p, setP] = useState<Preferences>(readPreferences),
    [audio, setAudio] = useState<WoodshedAudio | null>(null)
  const [practice, setPractice] = useState<PracticeLocation>({ instrument: null, exercise: null })
  const navigatePractice = (next: PracticeLocation): void => {
    setPractice(next)
    setP(old => ({ ...old, section: 'practice' }))
    scrollPositions.current.practice = 0
    scroll.current?.scrollTo(0, 0)
  }
  const [learning, setLearning] = useState<LearningLocation>({ system: null, node: null })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('bandbuddy-woodshed-sidebar') === 'collapsed' } catch { return false }
  })
  const toggleSidebar = (): void => {
    const next = !sidebarCollapsed
    setSidebarCollapsed(next)
    try { localStorage.setItem('bandbuddy-woodshed-sidebar', next ? 'collapsed' : 'expanded') } catch { /* Session state remains usable. */ }
  }
  const navigateLearning = (next: LearningLocation): void => {
    setLearning(next)
    scrollPositions.current.learn = 0
    setP(old => ({ ...old, section: 'learn' }))
    scroll.current?.scrollTo(0, 0)
  }
  const [tool, setTool] = useState<string | null>(null),
    [customOpen, setCustomOpen] = useState(false),
    [customText, setCustomText] = useState(''),
    [customError, setCustomError] = useState(''),
    [drone, setDrone] = useState(false)
  const scroll = useRef<HTMLDivElement>(null),
    storageFailed = useRef(false)
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
    return () => engine.destroy()
  }, [])
  useEffect(() => {
    void audio
      ?.setOutput(outputDeviceId)
      .catch((e) => error(`无法切换练功房输出：${e instanceof Error ? e.message : String(e)}`))
  }, [audio, outputDeviceId, error])
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
  }, [p.section, tool, audio])
  useEffect(() => {
    if (drone) {
      audio?.stop()
      setDrone(false)
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
  const selectInstrument = (id: string): void => {
    audio?.stop()
    const next = TUNINGS.find((t) => t.id === id)!
    const nextLesson =
      lesson.track === 'shared' || lesson.track === 'blues' || lesson.track === next.instrument
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
    if (section === 'tools') setTool(null)
    if (section === 'practice') { setPractice({ instrument: null, exercise: null }); scrollPositions.current.practice = 0; scroll.current?.scrollTo(0, 0) }
    if (section === 'learn') { setLearning({ system: null, node: null }); scroll.current?.scrollTo(0, 0) }
    setP((old) => ({ ...old, section }))
  }
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
  const renderWorkbench = (metronomeOnly = false): React.JSX.Element => (
    <Workbench
      tuning={tuning}
      preferences={p}
      patch={patch}
      onLabels={labels}
      audio={audio}
      onError={error}
      metronomeOnly={metronomeOnly}
    />
  )
  const instrumentSettings = (): React.JSX.Element => (
    <div className="ws-instrument-panel">
      <div className="ws-instrument-row">
        <label>
          乐器与调弦
          <select aria-label="乐器与调弦" value={p.tuningId} onChange={(e) => selectInstrument(e.target.value)}>
            {TUNINGS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button className={`ws-button ${p.customNotes ? 'active' : ''}`} aria-expanded={customOpen} onClick={() => {
          setCustomText(tuning.notes.map((n) => noteName(n)).join(' '))
          setCustomError('')
          setCustomOpen((value) => !value)
        }}>调弦与显示</button>
        <span>{p.customNotes ? '自定义调弦' : '预设调弦'} · 变调夹 {p.capo} 品</span>
      </div>
      {customOpen && (
        <div className="ws-custom-panel">
          <label>
            自定义空弦（从第 {preset.notes.length} 弦到第 1 弦，必须含八度）
            <input value={customText} onChange={(e) => setCustomText(e.target.value)} placeholder={preset.notes.map((n) => noteName(n)).join(' ')} />
          </label>
          <button className="ws-button primary" onClick={applyCustom}>应用调弦</button>
          <button className="ws-button" onClick={() => {
            setP((old) => ({ ...old, customNotes: null }))
            setCustomText(preset.notes.map((n) => noteName(n)).join(' '))
            setCustomError('')
          }}>恢复预设</button>
          <NumberField label="变调夹品位" value={p.capo} min={0} max={12} onChange={(capo) =>
            setP((old) => ({ ...old, capo, exercise: { ...old.exercise, minFret: 0, maxFret: Math.min(5, tuning.frets - capo) } }))
          } />
          <label className="ws-check"><input type="checkbox" checked={p.leftHanded} onChange={(e) => setP((old) => ({ ...old, leftHanded: e.target.checked }))} />左手显示</label>
          {customError && <p role="alert" className="ws-error">{customError}</p>}
        </div>
      )}
    </div>
  )
  return (
    <main className={`ws-page ${sidebarCollapsed ? 'ws-sidebar-collapsed' : ''}`}>
      <aside className="ws-sidebar">
        <button className="ws-sidebar-toggle" aria-label={sidebarCollapsed ? '展开左侧菜单' : '折叠左侧菜单'} title={sidebarCollapsed ? '展开左侧菜单' : '折叠左侧菜单'} aria-expanded={!sidebarCollapsed} aria-controls="woodshed-navigation" onClick={toggleSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <div className="ws-sidebar-brand">
          <div className="ws-brand-icon">
            <Guitar size={23} />
          </div>
          <div>
            <h1>练功房</h1>
          </div>
        </div>
        <nav id="woodshed-navigation" aria-label="练功房导航">
          {NAV.map((item) => (
            <button key={item.id} aria-label={item.name} title={sidebarCollapsed ? item.name : undefined} className={p.section === item.id ? 'selected' : ''} onClick={() => navigate(item.id)}>
              <item.icon size={19} />
              <span>
                <b>{item.name}</b>
              </span>
              {p.section === item.id && <ChevronRight size={15} />}
            </button>
          ))}
        </nav>
        <div className="ws-local">
          <span /> 本地可用 · 自由练习
        </div>
      </aside>
      <section className="ws-main">
        <header className="ws-topbar">
          <nav className="ws-breadcrumb" aria-label="页面路径">
            <button onClick={() => navigateLearning({ system: null, node: null })}>练功房</button><ChevronRight size={13} />
            {p.section === 'learn' ? <LearningBreadcrumb location={learning} onNavigate={navigateLearning} /> : p.section === 'practice' ? <PracticeBreadcrumb location={practice} onNavigate={navigatePractice} /> : <button onClick={() => navigate(p.section)}>{NAV.find(n => n.id === p.section)?.name}</button>}
            {p.section === 'tools' && tool && <><ChevronRight size={13} /><span aria-current="page">{TOOLS.find(item => item.id === tool)?.name}</span></>}
          </nav>
        </header>
        <div
          className={`ws-scroll ${p.section === 'tools' && tool ? 'ws-scroll-tool' : ''} ${tool === 'tuner' && p.section === 'tools' ? 'ws-scroll-tuner' : ''}`}
          ref={scroll}
          onScroll={(e) => {
            scrollPositions.current[p.section] = e.currentTarget.scrollTop
            if (scrollTimer.current) clearTimeout(scrollTimer.current)
            scrollTimer.current = setTimeout(persistScroll, 200)
          }}
        >
          {(p.section === 'lab' || p.section === 'tools') && (p.section !== 'tools' || !tool) && <div className="ws-hero">
            <div>
              <span className="ws-eyebrow">
                {p.section === 'lab'
                    ? 'A MAP FOR YOUR MUSIC.'
                      : 'READY WHEN YOU ARE.'}
              </span>
              <h2>
                {p.section === 'lab'
                    ? '在指板上，找到音乐。'
                      : '小工具，随手就好。'}
              </h2>
              <p>
                {p.section === 'lab'
                    ? '音名、音级、和弦与把位，在同一张指板上建立联系。'
                      : '调准音、稳住拍点，让注意力回到演奏本身。'}
              </p>
            </div>
            <div className="ws-hero-stat">
              <b>{p.section === 'tools' ? String(TOOLS.length).padStart(2, '0') : '12'}</b>
              <span>{p.section === 'tools' ? '常用工具' : '个调 · 自由探索'}</span>
            </div>
          </div>}
          {p.section === 'learn' && <Learning location={learning} onNavigate={navigateLearning} onPractice={navigatePractice} />}
          {p.section === 'lab' && <FretboardLab initialTuning={tuning} audio={audio} a4={p.a4} onBack={() => navigate('learn')} onError={error} />}
          {p.section === 'practice' && <Practice location={practice} onNavigate={navigatePractice} outputDeviceId={outputDeviceId} onError={error} onKnowledge={navigateLearning} />}
          {p.section === 'tools' && (
            <>
              {!tool ? <div className="ws-tool-cards">
                {TOOLS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setTool(item.id)
                      scroll.current?.scrollTo(0, 0)
                    }}
                  >
                    <item.icon size={28} />
                    <span><b>{item.name}</b><small>点击打开</small></span>
                    <ArrowRight size={18} />
                  </button>
                ))}
              </div> : <button className="ws-tool-back" onClick={() => setTool(null)}><ChevronRight size={15} /> 返回工具箱</button>}
              {tool === 'workshop' && <Suspense fallback={<div role="status">正在加载演奏工作台…</div>}><InstrumentWorkshopPage outputDeviceId={outputDeviceId} onToast={error} /></Suspense>}
              {tool === 'sample-drums' && <SampleDrumMachine outputDeviceId={outputDeviceId} onError={error} onBack={() => setTool(null)} />}
              {tool === 'metronome' && <Metronome outputDeviceId={outputDeviceId} onError={error} />}
              {tool === 'drums' && (
                <DrumMachine
                  machine={p.drumMachine}
                  update={(change) => setP((old) => ({ ...old, drumMachine: change(old.drumMachine) }))}
                  audio={audio}
                  onError={error}
                />
              )}
              {tool === 'tuner' && (
                <Tuner
                  presetControl={<SelectMenu ariaLabel="调弦方案" value={p.tuningId} options={TUNINGS.map((item) => ({ value: item.id, label: item.name }))} menuAnchor="parent" menuClassName="ws-tuner-preset-menu" optionHeight={37} onChange={selectInstrument} />}
                  instrumentSettings={instrumentSettings()}
                  tuning={tuning}
                  capo={p.capo}
                  a4={p.a4}
                  onA4={(a4) => setP((old) => ({ ...old, a4 }))}
                  inputDevice={p.inputDevice}
                  onDevice={(inputDevice) => setP((old) => ({ ...old, inputDevice, inputChannel: 0 }))}
                  inputChannel={p.inputChannel}
                  onChannel={(inputChannel) => setP((old) => ({ ...old, inputChannel }))}
                  onError={error}
                />
              )}
              {tool === 'chords' && <ChordLookup initialRoot={p.exercise.root} outputDeviceId={outputDeviceId} a4={p.a4} onError={error} />}
              {tool === 'circle' && (
                <HarmonyExplorer root={p.exercise.root} onRoot={root => patch({ root })} outputDeviceId={outputDeviceId} a4={p.a4} onError={error} />
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
                      } else
                        void audio
                          ?.drone(p.exercise.root, p.droneFifth)
                          .then(() => setDrone(true))
                          .catch((e) => error(String(e)))
                    }}
                  >
                    {drone ? <Square size={17} /> : <Volume2 size={17} />} {drone ? '停止参考音' : '播放参考音'}
                  </button>
                  <p>保持一个调性中心，慢弹音阶并听各音与根音的距离。比较同主音大小调或调式时保持 Drone 不变。</p>
                </section>
              )}
            </>
          )}
          {p.section === 'lab' && <footer className="ws-footer">
            <CircleHelp size={14} />
            <span>理解 → 听见 → 找到 → 演奏。按自己的节奏探索。</span>
            <button
              onClick={() => {
                audio?.stop()
                setP((old) => ({
                  ...old,
                  exercise: { ...DEFAULT_EXERCISE, bass: tuning.instrument === 'bass' ? 0 : 0.25 }
                }))
              }}
            >
              <RotateCcw size={12} />
              重置练习参数
            </button>
          </footer>}
        </div>
      </section>
    </main>
  )
}
