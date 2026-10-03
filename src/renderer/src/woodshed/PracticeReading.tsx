import { useEffect, useState } from 'react'
import type { LearningLocation } from './Learning.js'
import { LEARNING_SYSTEMS } from './knowledge.js'
import { loadLesson } from './lesson-library.js'
import type { LessonDocument, LessonInstrument } from './lesson-document.js'

/** Practice reads the same authored source as the textbook; no second copy of the guitar variants. */
export function PracticeReading({ knowledge, view, onKnowledge }: { knowledge: string[]; view: LessonInstrument; onKnowledge?: (location: LearningLocation) => void }): React.JSX.Element | null {
  const preferred = view.startsWith('guitar-') ? 'guitar' : view
  const nodes = LEARNING_SYSTEMS.flatMap(system => system.stages.flatMap(stage => stage.nodes.map(node => ({ ...node, system: system.id })))).filter(n => knowledge.includes(n.id)).sort((a, b) => Number(b.system === preferred) - Number(a.system === preferred))
  const first = nodes[0]
  const [lesson, setLesson] = useState<LessonDocument | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setLesson(null); setError('')
    if (first) void loadLesson(first.document, first.id).then(doc => { if (current) setLesson(doc) }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [first?.id, first?.document])
  if (!first) return null
  const context = lesson?.contexts?.[view]
  return <div className="ws-practice-reading">
    {error && <p role="alert">教材加载失败：{error}</p>}
    {context && <details className="ws-practice-explanation"><summary>{context.label}</summary>{context.paragraphs.map((p, i) => <p key={i}>{p}</p>)}</details>}
    {onKnowledge && <div className="ensemble-related">{nodes.map(node => <button className="ws-knowledge-practice" key={node.id} onClick={() => onKnowledge({ system: node.system, node: node.id, view })}>知识：{node.title}</button>)}</div>}
  </div>
}
