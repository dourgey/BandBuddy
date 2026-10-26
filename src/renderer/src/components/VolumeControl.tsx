import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { VolumeX } from 'lucide-react'
import { formatGainDb } from './LevelInput.js'

export function VolumeIcon({ value }: { value: number }): React.JSX.Element {
  const bars = value <= -60 ? 0 : value < -20 ? 1 : value < 0 ? 2 : 3
  if (!bars) return <VolumeX size={19} />
  return <svg width="19" height="19" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-volume-bars={bars}>
    <path d="M3 9h4l5-4v14l-5-4H3z" />
    <path d="M16 10a4 4 0 0 1 0 4" />
    {bars >= 2 && <path d="M20 7a8 8 0 0 1 0 10" />}
    {bars >= 3 && <path d="M24 4a12 12 0 0 1 0 16" />}
  </svg>
}

/** Shared hover/focus volume interaction for the master and individual tracks. */
export function VolumeControl({ label, value, disabled = false, onChange }: {
  label: string; value: number; disabled?: boolean; onChange(value: number): void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragging = useRef(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const latest = useRef({ value, disabled, onChange })
  const previousValue = useRef(value)
  if (value !== previousValue.current) { latest.current.value = value; previousValue.current = value }
  latest.current.disabled = disabled; latest.current.onChange = onChange
  const audible = useRef(value > -60 ? value : 0)
  useEffect(() => { if (value > -60) audible.current = value }, [value])
  const show = (): void => {
    if (disabled) return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    const bounds = root.current!.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 145, bounds.left + bounds.width / 2 - 21)), top: bounds.top >= 144 ? bounds.top - 139 : bounds.bottom + 7 })
    setOpen(true)
  }
  const hide = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!root.current?.contains(document.activeElement) && !popup.current?.contains(document.activeElement)) setOpen(false)
    }, 150)
  }
  const feedback = (): void => {
    show(); setAdjusting(true)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = setTimeout(() => { if (!dragging.current) setAdjusting(false) }, 800)
  }
  const change = (next: number): void => { latest.current.value = next; latest.current.onChange(next); feedback() }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); if (feedbackTimer.current) clearTimeout(feedbackTimer.current) }, [])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (latest.current.disabled || !event.deltaY) return
      event.preventDefault()
      event.stopPropagation()
      const next = Math.max(-60, Math.min(6, latest.current.value + (event.deltaY < 0 ? 0.5 : -0.5)))
      change(next)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    const panel = popup.current
    panel?.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel); panel?.removeEventListener('wheel', wheel) }
  }, [])
  const muted = value <= -60
  const volume = muted ? 0 : Math.min(200, Math.round(100 * 10 ** (value / 20)))
  return <div ref={root} className="master-volume-control" onClick={event => event.stopPropagation()}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
    onKeyDown={event => { if (event.key === 'Escape') setOpen(false); event.stopPropagation() }}>
    <button className={`volume-toggle ${muted ? 'is-muted' : ''}`} disabled={disabled}
      aria-label={`${label}：${muted ? '取消静音' : '静音'}`} aria-pressed={muted}
      title="悬停调音量 · 滚轮微调 · 点击静音"
      onClick={() => onChange(muted ? audible.current : -60)}
    ><VolumeIcon value={value} /></button>
    {createPortal(<div ref={popup} className={`master-volume-popover volume-floating ${open && !disabled ? 'is-open' : ''}`} role="group" aria-label={`${label}调节`}
      style={{ left: position.left, top: position.top }} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <input aria-label={label} disabled={disabled} type="range" min={0} max={200} value={volume}
        onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); feedback() }}
        onPointerUp={() => { dragging.current = false; feedback() }}
        onPointerCancel={() => { dragging.current = false; feedback() }}
        onLostPointerCapture={() => { if (dragging.current) { dragging.current = false; feedback() } }}
        onDoubleClick={() => change(0)}
        onChange={event => { const n = Number(event.target.value); change(n === 0 ? -60 : Math.min(6, 20 * Math.log10(n / 100))) }} />
      {adjusting && <output className="volume-db-feedback" role="status">{muted ? '−∞' : formatGainDb(value)} dB</output>}
    </div>, document.body)}
  </div>
}

export function InlineGainControl({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange(value: number): void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null), dragging = useRef(false)
  const [active, setActive] = useState(false)
  const current = useRef({ value, onChange }); current.current = { value, onChange }
  const feedback = (): void => {
    setActive(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { if (!dragging.current) setActive(false) }, 800)
  }
  useEffect(() => {
    const element = root.current
    const wheel = (event: WheelEvent): void => {
      if (!event.deltaY) return
      event.preventDefault(); event.stopPropagation()
      const next = Math.max(min, Math.min(max, current.current.value + (event.deltaY < 0 ? 0.5 : -0.5)))
      current.current.value = next; current.current.onChange(next); feedback()
    }
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => { element?.removeEventListener('wheel', wheel); if (timer.current) clearTimeout(timer.current) }
  }, [min, max])
  return <div ref={root} className="inline-gain-control">
    <VolumeIcon value={value} />
    <input className="metronome-volume-slider" aria-label={label} type="range" min={min} max={max} step="0.5" value={value}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); feedback() }}
      onPointerUp={() => { dragging.current = false; feedback() }} onPointerCancel={() => { dragging.current = false; feedback() }}
        onLostPointerCapture={() => { if (dragging.current) { dragging.current = false; feedback() } }}
      onDoubleClick={() => { onChange(0); feedback() }} onChange={event => { onChange(Number(event.target.value)); feedback() }} />
    {active && <output className="volume-db-feedback" role="status">{formatGainDb(value)} dB</output>}
  </div>
}
