import { useEffect, useRef, useState } from 'react'
import { SILENT_GAIN_DB } from '@shared/domain.js'
import { clamp, gainLabel } from '../utils.js'

// The slider and the input share the domain's own limits.
export const MIN_GAIN_DB = SILENT_GAIN_DB
export const MAX_GAIN_DB = 6
const STEP_DB = 0.5

export function formatGainDb(db: number): string {
  const rounded = Math.round(db * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

export function parseGainDb(text: string, min = MIN_GAIN_DB, max = MAX_GAIN_DB): number | null {
  const cleaned = text.trim().replace(/d\s*b$/i, '').trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null
  return clamp(Number(cleaned), min, max)
}

// Plain readout that becomes an editor only on double click. Readout and editor share the exact
// box metrics, so opening the editor never moves the neighbouring OUT column.
export function LevelInput({ value, disabled, label, min = MIN_GAIN_DB, max = MAX_GAIN_DB, onChange }: {
  value: number
  disabled?: boolean
  label: string
  min?: number
  max?: number
  onChange(gainDb: number): void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const cancelled = useRef(false)
  const editor = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    editor.current?.focus()
    editor.current?.select()
  }, [editing])

  const begin = (): void => {
    if (disabled || editing) return
    cancelled.current = false
    setDraft(formatGainDb(value))
    setEditing(true)
  }

  const finish = (): void => {
    const abandon = cancelled.current
    cancelled.current = false
    setEditing(false)
    if (abandon) return
    const parsed = parseGainDb(draft, min, max)
    if (parsed !== null && parsed !== value) onChange(parsed)
  }

  const step = (delta: number): void => {
    const base = parseGainDb(draft, min, max) ?? value
    const next = clamp(Math.round((base + delta) * 10) / 10, min, max)
    setDraft(formatGainDb(next))
    if (next !== value) onChange(next)
  }

  if (!editing) {
    return <button
      type="button"
      className="level-readout"
      disabled={disabled}
      aria-label={`${label}（双击编辑）`}
      title={`双击编辑：${gainLabel(value)}`}
      onDoubleClick={begin}
      onClick={(event) => { if (event.detail === 0) begin() }}
    >{gainLabel(value)}</button>
  }

  return <input
    ref={editor}
    className="level-editor"
    type="text"
    inputMode="decimal"
    aria-label={label}
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={finish}
    onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish() }
      else if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; finish() }
      else if (event.key === 'ArrowUp') { event.preventDefault(); step(STEP_DB) }
      else if (event.key === 'ArrowDown') { event.preventDefault(); step(-STEP_DB) }
    }}
  />
}
