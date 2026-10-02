import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Volume2, VolumeX } from 'lucide-react'

/** Shared hover/focus volume interaction for the master and individual tracks. */
export function VolumeControl({ label, value, disabled = false, onChange }: {
  label: string; value: number; disabled?: boolean; onChange(value: number): void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const latest = useRef({ value, disabled, onChange })
  latest.current = { value, disabled, onChange }
  const audible = useRef(value > -60 ? value : 0)
  useEffect(() => { if (value > -60) audible.current = value }, [value])
  const show = (): void => {
    if (disabled) return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    const bounds = root.current!.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 50, bounds.left + bounds.width / 2 - 21)), top: bounds.top >= 144 ? bounds.top - 139 : bounds.bottom + 7 })
    setOpen(true)
  }
  const hide = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!root.current?.contains(document.activeElement) && !popup.current?.contains(document.activeElement)) setOpen(false)
    }, 150)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (latest.current.disabled || !event.deltaY) return
      event.preventDefault()
      event.stopPropagation()
      const next = Math.max(-60, Math.min(6, latest.current.value + (event.deltaY < 0 ? 0.5 : -0.5)))
      latest.current.value = next
      latest.current.onChange(next)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    const panel = popup.current
    panel?.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel); panel?.removeEventListener('wheel', wheel) }
  }, [])
  const muted = value <= -60
  const volume = muted ? 0 : Math.min(150, Math.round(100 * 10 ** (value / 20)))
  return <div ref={root} className="master-volume-control" onClick={event => event.stopPropagation()}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
    onKeyDown={event => { if (event.key === 'Escape') setOpen(false); event.stopPropagation() }}>
    <button className={`volume-toggle ${muted ? 'is-muted' : ''}`} disabled={disabled}
      aria-label={`${label}：${muted ? '取消静音' : '静音'}`} aria-pressed={muted}
      title="悬停调音量 · 滚轮微调 · 点击静音"
      onClick={() => onChange(muted ? audible.current : -60)}
    >{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
    {createPortal(<div ref={popup} className={`master-volume-popover volume-floating ${open && !disabled ? 'is-open' : ''}`} role="group" aria-label={`${label}调节`}
      style={{ left: position.left, top: position.top }} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <input aria-label={label} disabled={disabled} type="range" min={0} max={150} value={volume}
        onDoubleClick={() => onChange(0)}
        onChange={event => { const n = Number(event.target.value); onChange(n === 0 ? -60 : Math.min(6, 20 * Math.log10(n / 100))) }} />
    </div>, document.body)}
  </div>
}
