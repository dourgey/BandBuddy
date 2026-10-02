import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Play, Square } from 'lucide-react'
import { EnsembleAudio, type EnsemblePlayback } from './ensemble-audio.js'
import { EnsembleScore } from './EnsembleScore.js'
import { EnsembleKeyboard } from './EnsembleKeyboard.js'
import { ENSEMBLE_INSTRUMENTS, ensembleKnowledgeSystem, type EnsembleExercise } from './ensemble-curriculum.js'
import { freshMaterial, measureBeats, type EnsembleScore as ScoreData } from './ensemble-material.js'
import { LEARNING_SYSTEMS } from './knowledge.js'
import type { LearningLocation } from './Learning.js'
import './ensemble.css'

const kindNames = { performance: '演奏专项', listening: '听觉专项', analysis: '分析与理解', equipment: '设备与声音', project: '完整音乐任务' }
const storageKey = (id: string): string => `bandbuddy.ensemble.practice.v1.${id}`
function readLog(id: string): { note: string; checked: boolean[] } {
 try { const value = JSON.parse(localStorage.getItem(storageKey(id)) ?? '{}'); return { note: typeof value.note === 'string' ? value.note.slice(0, 4000) : '', checked: [0, 1, 2].map(i => value.checked?.[i] === true) } } catch { return { note: '', checked: [false, false, false] } }
}
export function EnsemblePractice({ exercise, outputDeviceId, onError, onKnowledge }: {
 exercise: EnsembleExercise; outputDeviceId: string; onError: (message: string) => void; onKnowledge?: (location: LearningLocation) => void
}): React.JSX.Element {
 const [variantIndex, setVariantIndex] = useState(0), [bpm, setBpm] = useState(exercise.bpm)
 const [running, setRunning] = useState(false), [busy, setBusy] = useState(false), [seconds, setSeconds] = useState(0)
 const [demo, setDemo] = useState(exercise.kind === 'listening'), [silentBars, setSilentBars] = useState(0), [countIn, setCountIn] = useState(1)
 const [clickEvery, setClickEvery] = useState(exercise.sourceId === 'C01-03' ? 2 : 1)
 const [hidden, setHidden] = useState(exercise.kind === 'listening'), [transfer, setTransfer] = useState(false)
 const [error, setError] = useState(''), [log, setLog] = useState(() => readLog(exercise.id))
 const [synth, setSynth] = useState({ attack: .008, decay: .2, sustain: .65, release: .12, cutoff: 8000, waveform: 'triangle' as OscillatorType, lfoRate: 3, lfoDepth: 0, lfoTarget: 'pitch' as 'pitch' | 'volume' | 'filter' })
 const engine = useRef<EnsembleAudio | null>(null), animation = useRef(0), token = useRef(0), host = useRef<HTMLDivElement>(null), clock = useRef<HTMLOutputElement>(null)
 const [generated, setGenerated] = useState<ScoreData | null>(null)
 const score = generated ?? exercise.variants[variantIndex]
 const canRefresh = ['C03-01','C03-03','C03-05','C02-03','C06-01','P02-05','D08-01'].includes(exercise.sourceId)
 const isSynth = exercise.sourceId.startsWith('K08')
 const synthScore = useMemo<ScoreData>(() => ({ name: '声音比较', description: 'C4 长音：每次仅调整一个参数，然后重新试听。', meter: '4/4', beatUnit: 1, bars: 1, events: [{ id: 'synth-0', beat: 0, duration: 2, notes: [60], hand: 'R', velocity: .6 }] }), [])
 const activeScore = score ?? (isSynth ? synthScore : undefined)
 const timedTask: ScoreData = { name: '任务计时', description: '', meter: '4/4', beatUnit: 1, bars: 4, events: [] }
 const musical = !!activeScore || exercise.kind === 'performance'
 const stop = (): void => { token.current++; cancelAnimationFrame(animation.current); engine.current?.stop(); setRunning(false); setBusy(false); host.current?.querySelectorAll('.ensemble-active').forEach(n => n.classList.remove('ensemble-active')) }
 useEffect(() => {
  const audio = new EnsembleAudio(); engine.current = audio
  return () => { token.current++; cancelAnimationFrame(animation.current); audio.destroy(); engine.current = null }
 }, [outputDeviceId])
 useEffect(() => { setRunning(false); setBusy(false) }, [outputDeviceId])
 const save = (next: typeof log): void => {
  setLog(next)
  try { localStorage.setItem(storageKey(exercise.id), JSON.stringify(next)) } catch { setError('本地记录无法保存，本次内容仍保留在页面中。') }
 }
 const start = async (): Promise<void> => {
  const audio = engine.current
  if (!audio) return
  stop(); const ticket = ++token.current; setBusy(true); setError(''); setSeconds(0)
  try {
   if (musical) {
    const options: EnsemblePlayback = { bpm, demo: (demo || isSynth) && !!activeScore, countIn, silentBars, clickEvery, ...synth }
    if (!await audio.start(activeScore ?? timedTask, options, outputDeviceId) || ticket !== token.current) return
   }
   if (ticket !== token.current) return
   setRunning(true); setBusy(false)
   const began = performance.now()
   let previous = ''
   const draw = (): void => {
    if (ticket !== token.current) return
    const elapsed = Math.floor((performance.now() - began) / 1000)
    setSeconds(old => old === elapsed ? old : elapsed)
    const data = activeScore ?? timedTask, length = measureBeats(data.meter), position = audio.position
    const local = position >= 0 ? position % (length * data.bars) : -1
    const events = !audio.silent && local >= 0 && !hidden ? data.events.filter(e => local >= e.beat && local < e.beat + e.duration) : []
    const identity = events.map(e => e.id).join('|')
    if (identity !== previous) {
     host.current?.querySelectorAll('.ensemble-active').forEach(n => n.classList.remove('ensemble-active'))
     for (const e of events) {
      host.current?.querySelectorAll(`[data-ensemble-event="${e.id}"]`).forEach(n => n.classList.add('ensemble-active'))
      for (const midi of e.notes) host.current?.querySelectorAll(`[data-ensemble-midi="${midi}"]`).forEach(n => n.classList.add('ensemble-active'))
     }
     const note = host.current?.querySelector('.ensemble-active'), scroller = host.current?.querySelector('.ensemble-score')
     if (note && scroller) { const box = note.getBoundingClientRect(), viewport = scroller.getBoundingClientRect(); if (box.bottom > viewport.bottom || box.top < viewport.top) scroller.scrollTo({ top: scroller.scrollTop + box.top - viewport.top - 35 }) }
     previous = identity
    }
    if (clock.current) clock.current.textContent = !musical ? '任务进行中' : audio.silent ? '静音小节 · 内心数拍' : position < 0 ? '预备拍' : `第 ${Math.floor(local / length) + 1} 小节 · 第 ${Math.floor(local % length / data.beatUnit) + 1} 拍`
    animation.current = requestAnimationFrame(draw)
   }
   draw()
  } catch (e) { if (ticket === token.current) { stop(); const message = `无法开始：${e instanceof Error ? e.message : String(e)}`; setError(message); onError(message) } }
  finally { if (ticket === token.current) setBusy(false) }
 }
 const instrument = ENSEMBLE_INSTRUMENTS.find(i => i.id === exercise.instrument)!
 const beatLabel = (activeScore?.beatUnit ?? 1) === 1.5 ? '附点四分音符' : activeScore?.beatUnit === .5 ? '八分音符' : '四分音符'
 return <article className="ws-practice-detail ensemble-practice">
  <header className="ws-practice-title"><small>{exercise.sourceId} · {kindNames[exercise.kind]} · 建议 S{exercise.stage}{exercise.sourceId.startsWith('K11') ? ' · 可选支线' : ''}</small><h2>{exercise.title}</h2><p>{exercise.method}</p>
   <div className="ws-practice-variants" role="group" aria-label="练习变体">
    {exercise.variants.map((v, i) => <button key={v.name} disabled={running || busy} aria-pressed={!generated && variantIndex === i} onClick={() => { setGenerated(null); setVariantIndex(i); setSeconds(0) }}>{hidden && exercise.kind === 'listening' ? `材料 ${i + 1}` : v.name}</button>)}
    {canRefresh && <button disabled={running || busy} onClick={() => { setGenerated(freshMaterial(exercise.instrument, Date.now(), exercise.sourceId === 'C03-03')); setHidden(exercise.kind === 'listening'); setSeconds(0) }}>换一组陌生材料</button>}
    {!exercise.variants.length && <><button disabled={running || busy} aria-pressed={!transfer} onClick={() => setTransfer(false)}>基础任务</button><button disabled={running || busy} aria-pressed={transfer} onClick={() => setTransfer(true)}>迁移与复测</button></>}
   </div>
  </header>
  <section className="ensemble-task"><h3>{activeScore ? '当前材料' : transfer ? '迁移任务' : '执行任务'}</h3><p>{hidden && exercise.kind === 'listening' && activeScore ? '先播放并聆听参考音，再用口唱、敲击或乐器复现；停止后显示谱面核对。' : transfer ? exercise.transfer : activeScore?.description ?? exercise.material}</p>
   {!activeScore && <ol><li>{exercise.method}</li><li>先用上述短材料或一段同难度作品完成一次，记录出现问题的具体位置。</li><li>{exercise.transfer}</li></ol>}
  </section>
  {activeScore && <><button className="ws-knowledge-practice" disabled={running || busy} onClick={() => setHidden(!hidden)}>{hidden ? '显示谱面与答案' : '隐藏谱面，先听后复现'}</button><div ref={host} className={hidden ? 'ensemble-hidden' : ''} aria-hidden={hidden}>{!hidden && <><EnsembleScore score={activeScore} drums={activeScore.events.some(e => !!e.drum)} />{activeScore.events.some(e => e.notes.length > 0) && <EnsembleKeyboard score={activeScore} />}</>}</div></>}
  {isSynth && <fieldset className="ensemble-synth" disabled={running || busy}><legend>单参数声音比较 · 合成参考音</legend>
   <div className="ws-practice-variants" role="group" aria-label="声源波形">{(['sine','triangle','sawtooth','square'] as const).map((wave,i)=><button key={wave} aria-pressed={synth.waveform===wave} onClick={()=>setSynth({...synth,waveform:wave})}>{['正弦','三角','锯齿','方波'][i]}</button>)}</div>
   {([['attack', '起音', .005, 1.5, .005], ['decay','衰减',.01,1,.01], ['sustain','持续电平',0,1,.05], ['release', '释放', .02, 2, .02], ['cutoff', '低通频率', 100, 10000, 100], ['lfoRate','调制速率',.1,10,.1], ['lfoDepth','调制深度',0,1,.05]] as const).map(([key, label, min, max, step]) => <label key={key}>{label}<input aria-label={label} type="range" min={min} max={max} step={step} value={synth[key]} onChange={e => setSynth({ ...synth, [key]: Number(e.target.value) })} /><output>{synth[key]}{key === 'cutoff' || key === 'lfoRate' ? ' Hz' : key === 'sustain' || key === 'lfoDepth' ? '' : ' s'}</output></label>)}
   <div className="ws-practice-variants" role="group" aria-label="调制目标">{(['pitch','volume','filter'] as const).map((target,i)=><button key={target} aria-pressed={synth.lfoTarget===target} onClick={()=>setSynth({...synth,lfoTarget:target})}>{['音高','音量','滤波'][i]}</button>)}</div>
  </fieldset>}
  <div className="ws-practice-transport">
   {musical && <label className="ws-practice-tempo">速度 <input aria-label="节拍器速度" type="number" min={30} max={240} value={bpm} disabled={running || busy} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) setBpm(Math.max(30, Math.min(240, Math.round(n)))) }} /><span>BPM</span></label>}
   <button className="ws-practice-start" onClick={() => running || busy ? stop() : void start()}>{running || busy ? <Square size={17} /> : <Play size={18} />}{busy ? '取消' : running ? '停止' : musical ? '开始' : '开始任务计时'}</button>
   <output className="ws-practice-timer" aria-label="练习计时">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</output>
   <output ref={clock} aria-live="off">{running ? '' : '准备好后开始'}</output>
  </div>
  {musical && <fieldset className="ensemble-options" disabled={running || busy}><legend>练习条件 · {activeScore?.meter ?? '4/4'} · BPM 对应{beatLabel}</legend>
   {activeScore && !isSynth && <label><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} />播放合成参考音（关闭后仅节拍）</label>}
   <label>预备小节 <input type="number" min={0} max={4} value={countIn} onChange={e => setCountIn(Math.max(0, Math.min(4, Math.round(Number(e.target.value) || 0))))} /></label>
   <label>每 <input type="number" min={1} max={8} value={clickEvery} onChange={e => setClickEvery(Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1))))} /> 拍提示一次</label>
   <label>每个有声小节后静音 <input type="number" min={0} max={4} value={silentBars} onChange={e => setSilentBars(Math.max(0, Math.min(4, Math.round(Number(e.target.value) || 0))))} /> 小节</label>
  </fieldset>}
  {activeScore && <p className="ensemble-caption">参考音用于核对音高、节奏和层次；真实触奏、鼓件音色、踩镲闭合与踏板效果请在乐器上听辨。谱面手序为建议。</p>}
  {error && <p role="alert" className="ws-error">{error}</p>}
  <details className="ws-practice-explanation" open={!activeScore}><summary>练习讲解与里程碑<ChevronRight size={16} /></summary><div>
   <p>先修与准备：{exercise.prerequisites}</p><p>{exercise.method}</p><h3>预期达成里程碑 · 自行复核</h3>
   <ol>{exercise.milestones.map((m, i) => <li key={i}><label><input type="checkbox" checked={log.checked[i]} onChange={e => save({ ...log, checked: log.checked.map((v, j) => j === i ? e.target.checked : v) })} />{['完成', '稳定', '迁移'][i]}</label><span>{m}</span></li>)}</ol>
   <p className="ws-practice-context">{instrument.tuning}。这里只记录自评，不自动评分；录音、动作录像与设备结果需分别核对。</p>
  </div></details>
  <details className="ensemble-log"><summary>本次复盘与下次复测</summary><label>条件、问题位置、证据位置和下一步<textarea aria-label="练习复盘" maxLength={4000} value={log.note} placeholder="例如：60 BPM，第三小节左手过重；录音文件…；下次先练左手长音，隔日复测。" onChange={e => save({ ...log, note: e.target.value })} /></label></details>
  <nav className="ensemble-related" aria-label="相关知识">{exercise.knowledge.map(id => {
   const system = ensembleKnowledgeSystem(id) as LearningLocation['system']
   const node = LEARNING_SYSTEMS.find(s => s.id === system)?.stages.flatMap(s => s.nodes).find(n => n.id === id)
   return <button className="ws-knowledge-practice" key={id} onClick={() => onKnowledge?.({ system, node: id })}>知识：{node?.title ?? id}<ChevronRight size={14} /></button>
  })}</nav>
 </article>
}
