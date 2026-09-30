import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, ChevronRight, Guitar, Play, Square } from 'lucide-react'
import { Score } from './Score.js'
import { DEFAULT_EXERCISE, type MusicEvent } from './types.js'
import { noteName, type Tuning } from './theory.js'
import { DEFAULT_METRONOME, MetronomeEngine } from './metronome-engine.js'
import { PRACTICE_EXERCISES, PRACTICE_INSTRUMENTS, practiceFrame, practiceTuning, type PracticeExercise, type PracticeLocation, type PracticeVariant } from './practice-curriculum.js'
import './practice.css'

interface NavigationProps { location: PracticeLocation; onNavigate: (next: PracticeLocation) => void }
export function PracticeBreadcrumb({ location, onNavigate }: NavigationProps): React.JSX.Element {
  const instrument = PRACTICE_INSTRUMENTS.find(i => i.id === location.instrument)
  const exercise = PRACTICE_EXERCISES.find(e => e.id === location.exercise && e.instrument === instrument?.id)
  return <>
    <button onClick={() => onNavigate({ instrument: null, exercise: null })}>专项练习</button>
    {instrument && <><ChevronRight size={13} /><button onClick={() => onNavigate({ instrument: instrument.id, exercise: null })} aria-current={!exercise ? 'page' : undefined}>{instrument.title}</button></>}
    {exercise && <><ChevronRight size={13} /><span aria-current="page">{exercise.title}</span></>}
  </>
}

export function Practice({ location, onNavigate, outputDeviceId, onError }: NavigationProps & { outputDeviceId: string; onError: (message: string) => void }): React.JSX.Element {
  const instrument = PRACTICE_INSTRUMENTS.find(i => i.id === location.instrument)
  const exercise = PRACTICE_EXERCISES.find(e => e.id === location.exercise && e.instrument === instrument?.id)
  if (!instrument) return <div className="ws-learning-home ws-practice-home"><h2>专项练习</h2>
    <div className="ws-system-cards">{PRACTICE_INSTRUMENTS.map(i => {
      const Icon = i.id === 'bass' ? AudioLines : Guitar
      return <button className="ws-system-card" aria-label={i.title} key={i.id} onClick={() => onNavigate({ instrument: i.id, exercise: null })}>
        <Icon size={29} strokeWidth={1.4} /><span><strong>{i.title}</strong><small>{i.description}</small></span><ChevronRight size={17} />
      </button>
    })}</div>
  </div>
  if (!exercise) {
    const items = PRACTICE_EXERCISES.filter(e => e.instrument === instrument.id)
    const modules = [...new Set(items.map(e => e.module))]
    return <div className="ws-learning-map ws-practice-overview"><h2>{instrument.title}</h2>
      <div className="ws-practice-modules" aria-label={`${instrument.title}练习总览`}>{modules.map(module => <section key={module}>
        <h3>{module}</h3>
        <div>{items.filter(e => e.module === module).map(e => <button key={e.id} onClick={() => onNavigate({ instrument: instrument.id, exercise: e.id })}>{e.title}<ChevronRight size={14} /></button>)}</div>
      </section>)}</div>
    </div>
  }
  return <PracticeDetail key={exercise.id} exercise={exercise} outputDeviceId={outputDeviceId} onError={onError} />
}

interface PracticeDisplay { event: MusicEvent | undefined; pulse: number; bar: number; seconds: number }
const idle: PracticeDisplay = { event: undefined, pulse: -1, bar: 1, seconds: 0 }
export function PracticeDetail({ exercise, outputDeviceId, onError }: { exercise: PracticeExercise; outputDeviceId: string; onError: (message: string) => void }): React.JSX.Element {
  const [variantIndex, setVariantIndex] = useState(0)
  const [bpm, setBpm] = useState(exercise.bpm)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [display, setDisplay] = useState<PracticeDisplay>(idle)
  const [failure, setFailure] = useState('')
  const [engine, setEngine] = useState<MetronomeEngine | null>(null)
  const ticket = useRef(0)
  const frameId = useRef(0)
  const scoreHost = useRef<HTMLDivElement>(null)
  const variant = exercise.variants[variantIndex]!
  const tuning = practiceTuning(exercise.instrument)
  const beatsPerBar = Number(variant.meter.split('/')[0])
  const config = useMemo(() => ({ ...DEFAULT_EXERCISE, bpm, countIn: 0, rounds: 0, subdivision: 1, pattern: 'scale' as const, meter: variant.meter }), [bpm, variant.meter])

  useEffect(() => {
    const audio = new MetronomeEngine()
    setEngine(audio)
    setRunning(false)
    setBusy(false)
    setDisplay(idle)
    // start() routes output and reports any failure; no permission or device access until Start.
    void audio.setOutput(outputDeviceId)
    return () => { ticket.current++; cancelAnimationFrame(frameId.current); audio.destroy() }
  }, [outputDeviceId])

  const clearHighlight = (): void => {
    scoreHost.current?.querySelectorAll('[data-event].active').forEach(el => el.classList.remove('active'))
  }
  const stop = (): void => {
    ticket.current++
    cancelAnimationFrame(frameId.current)
    engine?.stop()
    setRunning(false)
    setBusy(false)
    setDisplay(old => ({ ...old, event: undefined, pulse: -1 }))
    clearHighlight()
  }
  const start = async (): Promise<void> => {
    if (!engine || busy) return
    const token = ++ticket.current
    setBusy(true)
    setFailure('')
    try {
      const started = await engine.start({ ...DEFAULT_METRONOME, bpm, beats: beatsPerBar, denominator: 4, subdivision: 1, countIn: 0, speedStep: 0, silentBars: 0, volume: 0.6 })
      if (!started || token !== ticket.current) return
      setRunning(true)
      setDisplay(idle)
      let origin: number | null = null
      const draw = (): void => {
        if (token !== ticket.current) return
        const pulse = engine.pulse()
        if (pulse) {
          if (origin === null) origin = pulse.time - pulse.index * pulse.duration
          const now = engine.now
          const fraction = Math.max(0, Math.min(1 - Number.EPSILON, (now - pulse.time) / pulse.duration))
          const frame = practiceFrame(variant, pulse.index + fraction)
          const next = { ...frame, seconds: Math.max(0, Math.floor(now - origin)) }
          setDisplay(old => old.event === next.event && old.pulse === next.pulse && old.bar === next.bar && old.seconds === next.seconds ? old : next)
          clearHighlight()
          if (frame.event) {
            const note = scoreHost.current?.querySelector(`[data-event="${frame.event.id}"]`)
            note?.classList.add('active')
            const scroller = scoreHost.current?.querySelector('.ws-score')
            if (note && scroller) {
              const box = note.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
              // Follow long scores inside their own viewport, without moving the page or controls.
              if (box.bottom > viewport.bottom || box.top < viewport.top) scroller.scrollTo({ top: scroller.scrollTop + box.top - viewport.top - 40 })
            }
          }
        }
        frameId.current = requestAnimationFrame(draw)
      }
      draw()
    } catch (e) {
      if (token !== ticket.current) return
      stop()
      const message = `无法开始练习：${e instanceof Error ? e.message : String(e)}`
      setFailure(message)
      onError(message)
    } finally {
      if (token === ticket.current) setBusy(false)
    }
  }
  const minutes = String(Math.floor(display.seconds / 60)).padStart(2, '0')
  const seconds = String(display.seconds % 60).padStart(2, '0')
  return <article className="ws-practice-detail">
    <header className="ws-practice-title"><h2>{exercise.title}</h2><p>{variant.description}</p>
      {exercise.variants.length > 1 && <div className="ws-practice-variants" role="group" aria-label="练习变体">{exercise.variants.map((v, index) => <button key={v.name} aria-pressed={index === variantIndex} disabled={running || busy} onClick={() => { stop(); setVariantIndex(index); setDisplay(idle) }}>{v.name}</button>)}</div>}
    </header>
    <div ref={scoreHost} className="ws-practice-score"><Score events={variant.events} tuning={tuning} config={config} compact /></div>
    <div className="ws-practice-transport">
      <label className="ws-practice-tempo">速度 <input aria-label="节拍器速度" type="number" min={30} max={240} step={1} value={bpm} disabled={running || busy} onChange={e => {
        const value = Number(e.target.value)
        if (Number.isFinite(value)) setBpm(Math.max(30, Math.min(240, Math.round(value))))
      }} /><span>BPM</span></label>
      <button className="ws-practice-start" disabled={!engine} onClick={() => running || busy ? stop() : void start()}>
        {running || busy ? <Square size={17} /> : <Play size={18} />}{busy ? '取消' : running ? '停止' : '开始'}
      </button>
      <output className="ws-practice-timer" aria-label="练习计时">{minutes}:{seconds}</output>
      <div className="ws-practice-beats" aria-label={running && display.pulse >= 0 ? `第 ${display.bar} 小节，第 ${display.pulse + 1} 拍` : `${variant.meter} 节拍提示`}>{Array.from({ length: beatsPerBar }, (_, i) => <i key={i} className={running && display.pulse === i ? 'active' : ''} />)}</div>
    </div>
    {failure && <p className="ws-error" role="alert">{failure}</p>}
    <PracticeFretboard variant={variant} tuning={tuning} active={running ? display.event : undefined} />
    <details className="ws-practice-explanation">
      <summary>练习讲解与里程碑<ChevronRight size={16} /></summary>
      <div><p>{exercise.explanation}</p>
        <h3>预期达成里程碑</h3>
        <ol>{exercise.milestones.map((m, i) => <li key={m}><b>{['完成', '稳定', '迁移'][i]}</b><span>{m}</span></li>)}</ol>
        <p className="ws-practice-context">{PRACTICE_INSTRUMENTS.find(i => i.id === exercise.instrument)!.tuning} · {variant.meter} 拍，BPM 对应四分音符。里程碑供自行复核。</p>
      </div>
    </details>
  </article>
}

function PracticeFretboard({ variant, tuning, active }: { variant: PracticeVariant; tuning: Tuning; active: MusicEvent | undefined }): React.JSX.Element {
  const notes = [...new Map(variant.events.flatMap(e => e.notes).map(n => [`${n.string}-${n.fret}`, n])).values()]
  const min = Math.min(...notes.map(n => n.fret))
  const max = Math.max(min + 3, ...notes.map(n => n.fret))
  const columns = max - min + 1
  const width = Math.max(900, columns * 64 + 75)
  const height = tuning.notes.length * 28 + 45
  const x = (fret: number): number => 70 + (fret - min + 0.5) * (width - 90) / columns
  const y = (string: number): number => 24 + (string - 1) * 28
  return <figure className="ws-practice-fretboard">
    <div className="ws-practice-fretboard-scroll"><svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: Math.min(width, 540) }} role="img" aria-label={`${tuning.notes.length}弦练习指板，${min}至${max}品`}>
      <rect x="58" y="8" width={width - 68} height={height - 42} rx="5" fill="#eee4d3" />
      {Array.from({ length: columns + 1 }, (_, i) => <line key={i} x1={70 + i * (width - 90) / columns} x2={70 + i * (width - 90) / columns} y1="9" y2={height - 34} stroke="#c0ae93" strokeWidth={i === 0 && min === 0 ? 4 : 1} />)}
      {[...tuning.notes].reverse().map((midi, i) => <g key={i}><text x="0" y={y(i + 1) + 4} fontSize="10">{i + 1}弦 {noteName(midi, false)}</text><line x1="58" x2={width - 10} y1={y(i + 1)} y2={y(i + 1)} stroke="#a69985" strokeWidth={0.8 + i * 0.2} /></g>)}
      {Array.from({ length: columns }, (_, i) => <text key={i} x={x(min + i)} y={height - 11} textAnchor="middle" fontSize="11">{min + i === 0 ? '空弦' : min + i}</text>)}
      {notes.map(n => {
        const current = active?.notes.some(p => p.string === n.string && p.fret === n.fret) ?? false
        return <g key={`${n.string}-${n.fret}`} data-position={`${n.string}:${n.fret}`} data-active={current ? 'true' : 'false'}>
          <circle cx={x(n.fret)} cy={y(n.string)} r="12" fill={current ? '#b46b42' : '#f7f4ed'} stroke={current ? '#9f5934' : '#8a947b'} strokeWidth={current ? 2 : 1} />
          <text x={x(n.fret)} y={y(n.string) + 4} textAnchor="middle" fontSize="10" fill={current ? '#fff' : '#4a5548'}>{n.fret}</text>
          <title>{n.string} 弦 {n.fret} 品 · {noteName(n.midi)}{current ? ' · 当前发音' : ''}</title>
        </g>
      })}
    </svg></div>
    <figcaption aria-live="off">{active ? active.notes.length ? `${active.notes.map(n => `${n.string}弦${n.fret}品`).join(' · ')}${active.bend ? ' · 推高全音' : active.technique === 'mute' ? ' · 闷音' : ''}` : '休止' : '第一弦在上 · 开始后随节拍高亮'}</figcaption>
  </figure>
}
