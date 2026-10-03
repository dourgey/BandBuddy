import { NotationBody } from './NotationBody.js'
import { useEffect, useState } from 'react'
import { BookOpen, ChevronRight, Guitar, AudioLines, Music2, Drum, Piano, KeyboardMusic } from 'lucide-react'
import { LEARNING_SYSTEMS, type KnowledgeReference, type ReadingSystem, type SystemId } from './knowledge.js'
import { PRACTICE_EXERCISES, type PracticeLocation } from './practice-curriculum.js'
import { ENSEMBLE_EXERCISES, ENSEMBLE_INSTRUMENTS, ENSEMBLE_PREREQUISITES } from './ensemble-curriculum.js'
import type { LessonContext, LessonDocument, LessonInstrument, LessonScore } from './lesson-document.js'
import { loadLesson, loadLessonScore, lessonDiagramUrl } from './lesson-library.js'
import { LESSON_INSTRUMENTS, LessonTabs } from './LessonTabs.js'
import { MusicXmlScore } from './MusicXmlScore.js'
import './learning.css'
import './ensemble.css'

export interface LearningLocation { system: SystemId | null; node: string | null; view?: LessonInstrument }
const icons = { shared: BookOpen, guitar: Guitar, bass: AudioLines, ukulele: Guitar, blues: Music2, drums: Drum, piano: Piano, keyboard: KeyboardMusic, ensemble: BookOpen }
const variants = (system: SystemId) => system === 'guitar' ? LESSON_INSTRUMENTS.slice(0, 2) : ['shared', 'ensemble', 'blues'].includes(system) ? LESSON_INSTRUMENTS : LESSON_INSTRUMENTS.filter(i => i.id === system)
export const practiceInstrumentForView = (view: LessonInstrument): NonNullable<PracticeLocation['instrument']> => view.startsWith('guitar-') ? 'guitar' : view as NonNullable<PracticeLocation['instrument']>

export function LearningBreadcrumb({ location, onNavigate }: { location: LearningLocation; onNavigate: (next: LearningLocation) => void }): React.JSX.Element {
  const system = LEARNING_SYSTEMS.find(s => s.id === location.system)
  const node = system?.stages.flatMap(s => s.nodes).find(n => n.id === location.node)
  return <>
    <button onClick={() => onNavigate({ system: null, node: null, view: location.view })}>系统学习</button>
    {system && <><ChevronRight size={13} /><button onClick={() => onNavigate({ system: system.id, node: null, view: location.view })} aria-current={!node ? 'page' : undefined}>{system.title}</button></>}
    {node && <><ChevronRight size={13} /><span aria-current="page">{node.title}</span></>}
  </>
}

export function Learning({ location, onNavigate, onPractice }: { location: LearningLocation; onNavigate: (next: LearningLocation) => void; onPractice?: (next: PracticeLocation) => void }): React.JSX.Element {
  const system = LEARNING_SYSTEMS.find(s => s.id === location.system)
  const node = system?.stages.flatMap(s => s.nodes).find(n => n.id === location.node)
  const options = variants(system?.id ?? 'shared')
  const selected = options.find(i => i.id === location.view)?.id ?? options[0]!.id
  const select = (view: LessonInstrument): void => onNavigate({ ...location, view })
  const prefix = ENSEMBLE_INSTRUMENTS.find(i => i.id === system?.id)?.prefix
  if (!system) return <div className="ws-learning-home">
    <h2>系统学习</h2>
    <div className="ws-system-cards">{LEARNING_SYSTEMS.map(s => {
      const Icon = icons[s.id]
      return <button className="ws-system-card" aria-label={s.title} key={s.id} onClick={() => onNavigate({ system: s.id, node: null, view: location.view })}>
        <Icon size={29} strokeWidth={1.4} /><span><strong>{s.title}</strong><small>{s.description}</small></span><ChevronRight size={17} />
      </button>
    })}</div>
  </div>
  if (!node) return <div className="ws-learning-map">
    <h2>{system.title}</h2>
    {options.length > 1 && <LessonTabs value={selected} onChange={select} options={options}><p className="ws-version-intro">{system.context} 正文将显示{options.find(o => o.id === selected)!.label}的讲解与示例。</p></LessonTabs>}
    <ol className="ws-knowledge-roadmap" aria-label={`${system.title}知识路线图`}>{system.stages.map((stage, i) => <li key={stage.title}>
      <div className="ws-stage-label"><span>{String(i + 1).padStart(2, '0')}</span><h3>{stage.title}</h3></div>
      <div className="ws-knowledge-nodes">{stage.goal && <p className="ws-stage-goal">阶段成果：{stage.goal}</p>}{stage.nodes.map(n => <button key={n.id} onClick={() => onNavigate({ system: system.id, node: n.id, view: selected })}>{n.title}<ChevronRight size={14} /></button>)}</div>
    </li>)}</ol>
    {prefix && <details className="ensemble-log"><summary>先修关系与进入条件</summary><dl>{ENSEMBLE_PREREQUISITES.filter(p => p.prefix === prefix).map(p => <div key={p.title}><dt>{p.title}</dt><dd>{p.detail}</dd></div>)}</dl></details>}
  </div>
  return <LessonArticle key={node.id} node={node} system={system} view={selected} select={select} onPractice={onPractice} onNavigate={onNavigate} />
}

function LessonArticle({ node, system, view, select, onPractice, onNavigate }: {
  node: KnowledgeReference; system: ReadingSystem; view: LessonInstrument; select: (view: LessonInstrument) => void;
  onPractice?: (next: PracticeLocation) => void; onNavigate: (next: LearningLocation) => void
}): React.JSX.Element {
  const [lesson, setLesson] = useState<LessonDocument | null>(null)
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setLesson(null); setError('')
    void loadLesson(node.document, node.id).then(value => { if (current) setLesson(value) }).catch(e => { if (current) setError(e instanceof Error ? e.message : String(e)) })
    return () => { current = false }
  }, [node.document, node.id, attempt])
  const context = lesson?.contexts?.[view]
  const instrument = practiceInstrumentForView(view)
  const related = [...PRACTICE_EXERCISES, ...ENSEMBLE_EXERCISES].filter(e => e.instrument === instrument && e.knowledge.includes(node.id) && !('kind' in e && e.kind === 'comprehensive'))
  const options = variants(system.id)
  const nodes = system.stages.flatMap(s => s.nodes), index = nodes.findIndex(n => n.id === node.id)
  const media = (lesson?.scores ?? []).filter(s => !s.instruments || s.instruments.includes(view))
  const diagrams = (lesson?.diagrams ?? []).filter(d => !d.instruments || d.instruments.includes(view))
  return <NotationBody instrument={view} className="ws-knowledge-article" aria-busy={!lesson && !error}>
    <h2>{node.title}</h2><p className="ws-knowledge-context">{system.context}</p>
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(x => x + 1)}>重新加载教材</button></div> : !lesson ? <p role="status">正在加载教材…</p> : <>
      <p className="ws-lesson-summary">{lesson.summary}</p>
      <section className="ws-lesson-objectives"><h3>读完这一课</h3><ul>{lesson.objectives.map(item => <li key={item}>{item}</li>)}</ul></section>
      {options.length > 1 ? <LessonTabs value={view} onChange={select} options={options}><LessonContextContent context={context} label={options.find(o => o.id === view)!.label} /></LessonTabs> : context && <LessonContextContent context={context} label={options[0]!.label} />}
      {lesson.sections.map((section, i) => <section key={i}><h3>{section.title}</h3>{section.paragraphs.map((p, j) => <p key={j}>{p}</p>)}</section>)}
      {diagrams.map(d => <figure className="ws-knowledge-figure" key={d.src}><img src={lessonDiagramUrl(d.src)} alt={d.alt} /><figcaption>{d.caption}</figcaption></figure>)}
      <section><h3>把概念放进例子</h3><p>{context?.example ?? lesson.example}</p></section>
      {media.map(score => <LessonNotation key={score.src} score={score} />)}
      <section><h3>一步一步做</h3><ol className="ws-lesson-steps">{(context?.steps ?? lesson.steps).map((step, i) => <li key={i}>{step}</li>)}</ol></section>
      <section><h3>听到问题时怎样排查</h3><dl className="ws-lesson-mistakes">{lesson.mistakes.map((m, i) => <div key={i}><dt>{m.problem}</dt><dd>{m.correction}</dd></div>)}</dl></section>
      <section><h3>自检与复述</h3><ul>{lesson.checks.map((check, i) => <li key={i}>{check}</li>)}</ul></section>
      {lesson.references && <details className="ws-lesson-references"><summary>延伸阅读与资料来源</summary><ul>{lesson.references.map(ref => <li key={ref.url}><a href={ref.url} target="_blank" rel="noreferrer">{ref.title}</a></li>)}</ul></details>}
      {onPractice && <section className="ws-lesson-practice-links"><h3>相关专项练习</h3>{related.length ? related.map(e => <button className="ws-knowledge-practice" key={e.id} onClick={() => onPractice({ instrument, exercise: e.id, view })}>{e.title}<ChevronRight size={14} /></button>) : <button className="ws-knowledge-practice" onClick={() => onPractice({ instrument, exercise: null, view })}>前往{LESSON_INSTRUMENTS.find(i => i.id === view)!.label}专项练习<ChevronRight size={14} /></button>}</section>}
      <nav className="ws-lesson-pagination" aria-label="教材章节">{index > 0 && <button onClick={() => onNavigate({ system: system.id, node: nodes[index - 1]!.id, view })}>上一课 · {nodes[index - 1]!.title}</button>}{index + 1 < nodes.length && <button onClick={() => onNavigate({ system: system.id, node: nodes[index + 1]!.id, view })}>下一课 · {nodes[index + 1]!.title}</button>}</nav>
    </>}
  </NotationBody>
}
function LessonContextContent({ context, label }: { context: LessonContext | undefined; label: string }): React.JSX.Element {
  return <section className="ws-lesson-context"><h3>{context?.label ?? `${label}中的应用`}</h3>{context ? context.paragraphs.map((p, i) => <p key={i}>{p}</p>) : <p>本课的概念适用于{label}；以下按共同的音乐关系讲解。</p>}</section>
}
function LessonNotation({ score }: { score: LessonScore }): React.JSX.Element {
  const [xml, setXml] = useState(''), [error, setError] = useState('')
  useEffect(() => { let current = true; setXml(''); setError(''); void loadLessonScore(score.src).then(value => { if (current) setXml(value) }).catch(e => { if (current) setError(String(e)) }); return () => { current = false } }, [score.src])
  return <figure className="ws-lesson-notation">{error ? <p role="alert">{error}</p> : xml ? <MusicXmlScore xml={xml} label={score.caption} /> : <p role="status">正在加载谱例…</p>}<figcaption>{score.caption}</figcaption></figure>
}
