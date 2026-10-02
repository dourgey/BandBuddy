import { BookOpen, ChevronRight, Guitar, AudioLines, Music2, Drum, Piano, KeyboardMusic } from 'lucide-react'
import { LEARNING_SYSTEMS, type Knowledge, type SystemId } from './knowledge.js'
import { exerciseForKnowledge, type PracticeLocation } from './practice-curriculum.js'
import { ENSEMBLE_EXERCISES, ENSEMBLE_INSTRUMENTS, ENSEMBLE_PREREQUISITES } from './ensemble-curriculum.js'
import './learning.css'
import './ensemble.css'

export interface LearningLocation { system: SystemId | null; node: string | null }
const icons = { shared: BookOpen, guitar: Guitar, bass: AudioLines, ukulele: Guitar, blues: Music2, drums: Drum, piano: Piano, keyboard: KeyboardMusic, ensemble: BookOpen }

export function LearningBreadcrumb({ location, onNavigate }: { location: LearningLocation; onNavigate: (next: LearningLocation) => void }): React.JSX.Element {
  const system = LEARNING_SYSTEMS.find(s => s.id === location.system)
  const node = system?.stages.flatMap(s => s.nodes).find(n => n.id === location.node)
  return <>
    <button onClick={() => onNavigate({ system: null, node: null })}>系统学习</button>
    {system && <><ChevronRight size={13} /><button onClick={() => onNavigate({ system: system.id, node: null })} aria-current={!node ? 'page' : undefined}>{system.title}</button></>}
    {node && <><ChevronRight size={13} /><span aria-current="page">{node.title}</span></>}
  </>
}

export function Learning({ location, onNavigate, onPractice }: { location: LearningLocation; onNavigate: (next: LearningLocation) => void; onPractice?: (next: PracticeLocation) => void }): React.JSX.Element {
  const system = LEARNING_SYSTEMS.find(s => s.id === location.system)
  const node = system?.stages.flatMap(s => s.nodes).find(n => n.id === location.node)
  const practice = node ? exerciseForKnowledge(node.id) : undefined
  const prefix = ENSEMBLE_INSTRUMENTS.find(i => i.id === system?.id)?.prefix
  const related = node?.id.startsWith('ensemble-') ? ENSEMBLE_EXERCISES.filter(e => e.knowledge.includes(node.id)) : []
  if (!system) return <div className="ws-learning-home">
    <h2>系统学习</h2>
    <div className="ws-system-cards">{LEARNING_SYSTEMS.map(s => {
      const Icon = icons[s.id as keyof typeof icons] ?? icons.shared
      return <button className="ws-system-card" aria-label={s.title} key={s.id} onClick={() => onNavigate({ system: s.id, node: null })}>
        <Icon size={29} strokeWidth={1.4} /><span><strong>{s.title}</strong><small>{s.description}</small></span><ChevronRight size={17} />
      </button>
    })}</div>
  </div>
  if (!node) return <div className="ws-learning-map">
    <h2>{system.title}</h2>
    <ol className="ws-knowledge-roadmap" aria-label={`${system.title}知识路线图`}>{system.stages.map((stage, i) => <li key={stage.title}>
      <div className="ws-stage-label"><span>{String(i + 1).padStart(2, '0')}</span><h3>{stage.title}</h3></div>
      <div className="ws-knowledge-nodes">{stage.goal && <p className="ws-stage-goal">阶段成果：{stage.goal}</p>}{stage.nodes.map(n => <button key={n.id} onClick={() => onNavigate({ system: system.id, node: n.id })}>{n.title}<ChevronRight size={14} /></button>)}</div>
    </li>)}</ol>
    {prefix && <details className="ensemble-log"><summary>先修关系与进入条件</summary><dl>{ENSEMBLE_PREREQUISITES.filter(p => p.prefix === prefix).map(p => <div key={p.title}><dt>{p.title}</dt><dd>{p.detail}</dd></div>)}</dl></details>}
  </div>
  return <article className="ws-knowledge-article" key={node.id}>
    <h2>{node.title}</h2>
    <p className="ws-knowledge-context">{system.context}</p>
    {node.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
    {!node.id.startsWith('ensemble-') && <KnowledgeFigure id={node.id} system={system.id} figure={node.figure} />}
    <section><h3>举个例子</h3><p>{node.example}</p></section>
    {node.note && <section><h3>容易混淆的地方</h3><p>{node.note}</p></section>}
    {practice && onPractice && <button className="ws-knowledge-practice" onClick={() => onPractice({ instrument: practice.instrument, exercise: practice.id })}>练习<ChevronRight size={14} /></button>}
    {related.length > 0 && onPractice && <details className="ensemble-log"><summary>相关专项练习</summary><div className="ensemble-related">{related.map(e => <button className="ws-knowledge-practice" key={e.id} onClick={() => onPractice({ instrument: e.instrument, exercise: e.id })}>{node.id.startsWith('ensemble-C') ? `${ENSEMBLE_INSTRUMENTS.find(i => i.id === e.instrument)!.title} · ` : ''}{e.title}<ChevronRight size={14} /></button>)}</div></details>}
  </article>
}

function KnowledgeFigure({ id, system, figure }: { id: string; system: SystemId; figure?: Knowledge['figure'] }): React.JSX.Element | null {
  if (figure === 'signal') return <figure className="ws-knowledge-figure">
    <div className="ws-signal-diagram" aria-label={`${system === 'bass' ? '贝斯' : '尤克里里'}录音信号链`}>{[system === 'bass' ? '贝斯 / DI' : '话筒 / 乐器拾音', '合适的声卡输入', '录音轨', '耳机 / 监听'].map((s, i) => <span key={s}>{i > 0 && <ChevronRight size={16} />}<b>{s}</b></span>)}</div>
    <figcaption>输入增益控制录入电平；监听音量控制听到的响度。原始录音与效果处理可以分别保存。</figcaption>
  </figure>
  if (figure === 'chords') return <figure className="ws-knowledge-figure">
    <table className="ws-rhythm-example"><caption>高 G 定弦 · 从第四弦到第一弦的品位</caption><thead><tr><th scope="col">和弦</th>{['4 · G4', '3 · C4', '2 · E4', '1 · A4'].map(s => <th scope="col" key={s}>{s}</th>)}</tr></thead>
      <tbody>{(id === 'ukulele-13' ? [['C', 0, 0, 0, 3], ['Cmaj7', 0, 0, 0, 2], ['C7', 0, 0, 0, 1]] : [['C', 0, 0, 0, 3], ['Am', 2, 0, 0, 0], ['F', 2, 0, 1, 0], ['G', 0, 2, 3, 2]]).map(row => <tr key={row[0]}><th scope="row">{row[0]}</th>{row.slice(1).map((fret, i) => <td key={i}>{fret}</td>)}</tr>)}</tbody>
    </table><figcaption>0 表示空弦。此处横向排列弦号；专项练习中的四线谱则从上到下排列第一至第四弦。</figcaption>
  </figure>
  if (['guitar-outline-0-3', 'guitar-outline-4-6', 'guitar-outline-4-7'].includes(id)) return <figure className="ws-knowledge-figure">
    <div className="ws-signal-diagram" aria-label="数字吉他信号链">{['吉他', '乐器输入', '音箱模拟', '箱体处理', '耳机 / 监听'].map((s, i) => <span key={s}>{i > 0 && <ChevronRight size={16} />}<b>{s}</b></span>)}</div>
    <figcaption>信号从左向右流动；输入增益与最终监听音量位于不同环节。</figcaption>
  </figure>
  if (figure === 'rhythm' || ['guitar-outline-1-3', 'guitar-outline-2-3', 'shared-7'].includes(id)) return <figure className="ws-knowledge-figure">
    <table className="ws-rhythm-example"><caption>4/4 拍 · 八分音符细分示意</caption><thead><tr>{['1', '和', '2', '和', '3', '和', '4', '和'].map((s, i) => <th scope="col" key={i}>{s}</th>)}</tr></thead><tbody><tr>{['发音', '延续', '发音', '发音', '休止', '休止', '发音', '延续'].map((s, i) => <td key={i}>{s}</td>)}</tr></tbody></table>
    <figcaption>每格为半拍。「延续」保持前一个音，「休止」停止发声，拍子继续。</figcaption>
  </figure>
  if (figure !== 'fretboard' && !['guitar-outline-0-2', 'guitar-outline-1-1', 'guitar-outline-4-1', 'shared-1', 'shared-2'].includes(id)) return null
  const notes = system === 'bass' ? [43, 38, 33, 28] : system === 'ukulele' ? [69, 64, 60, 67] : [64, 59, 55, 50, 45, 40]
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return <figure className="ws-knowledge-figure">
    <svg viewBox={`0 0 620 ${notes.length * 44 + 48}`} role="img" aria-label="固定标准定弦指板，第一弦在上，显示空弦至第五品的音名">
      {Array.from({ length: 6 }, (_, f) => <g key={f}><text x={65 + f * 100} y="18" textAnchor="middle">{f === 0 ? '空弦' : `${f} 品`}</text>{f > 0 && <line x1={f * 100 + 15} x2={f * 100 + 15} y1="30" y2={notes.length * 44 + 12} stroke="#c7bdab" />}</g>)}
      {notes.map((midi, s) => <g key={s}><text x="8" y={49 + s * 44}>{s + 1}</text><line x1="45" x2="598" y1={44 + s * 44} y2={44 + s * 44} stroke="#a69b87" />{Array.from({ length: 6 }, (_, f) => <g key={f}><circle cx={65 + f * 100} cy={44 + s * 44} r="18" fill="#f7f4ed" stroke={f === 0 ? '#496d64' : '#c7bdab'} /><text x={65 + f * 100} y={49 + s * 44} textAnchor="middle">{names[(midi + f) % 12]}</text></g>)}</g>)}
    </svg>
    <figcaption>第一弦在上；每向右一品升高一个半音。此图固定展示本体系的定弦。</figcaption>
  </figure>
}
