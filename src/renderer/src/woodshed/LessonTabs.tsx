import { useId } from 'react'
import type { LessonInstrument } from './lesson-document.js'

export const LESSON_INSTRUMENTS: { id: LessonInstrument; label: string }[] = [
  { id: 'guitar-electric', label: '电吉他' }, { id: 'guitar-acoustic', label: '原声吉他' },
  { id: 'bass', label: '贝斯' }, { id: 'ukulele', label: '尤克里里' }, { id: 'drums', label: '鼓' },
  { id: 'piano', label: '钢琴' }, { id: 'keyboard', label: '现代键盘' }
]
export function LessonTabs({ value, onChange, options = LESSON_INSTRUMENTS, children }: {
  value: LessonInstrument; onChange: (value: LessonInstrument) => void;
  options?: typeof LESSON_INSTRUMENTS; children?: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return <div className="ws-lesson-views">
    <div className="ws-lesson-tabs" role="tablist" aria-label="乐器讲解版本">{options.map((option, i) => <button
      key={option.id} type="button" role="tab" id={`${id}-${option.id}`} aria-selected={value === option.id}
      aria-controls={`${id}-panel`} tabIndex={value === option.id ? 0 : -1}
      onClick={() => onChange(option.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (i + 1) % options.length : event.key === 'ArrowLeft' ? (i + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
        if (next < 0) return
        event.preventDefault(); onChange(options[next]!.id)
        document.getElementById(`${id}-${options[next]!.id}`)?.focus()
      }}>{option.label}</button>)}</div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>{children}</div>
  </div>
}
