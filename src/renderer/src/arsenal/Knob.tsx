import { useEffect, useRef, type CSSProperties } from 'react'
export function Knob({ label, value, min = 0, max = 1, step = .01, unit = '', onChange }: { label: string; value: number; min?: number; max?: number; step?: number; unit?: string; onChange(value: number): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null), current = useRef({ value, onChange, min, max, step })
  current.current = { value, onChange, min, max, step }
  const drag = useRef<{ y: number; value: number } | null>(null)
  const change = (v: number): void => { const c = current.current; c.onChange(Math.min(c.max, Math.max(c.min, Number((Math.round(v / c.step) * c.step).toFixed(5))))) }
  useEffect(() => { const el = host.current; if (!el) return; const wheel = (e: WheelEvent): void => { e.preventDefault(); change(current.current.value + (e.deltaY < 0 ? 1 : -1) * current.current.step * (e.shiftKey ? 10 : 1)) }; el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel) }, [])
  return <div className="marshall-control"><span>{label}</span><div ref={host} className="marshall-knob" role="slider" tabIndex={0} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} style={{ '--rotation': `${-135 + (value - min) / (max - min) * 270}deg` } as CSSProperties}
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, value } }} onPointerMove={e => { if (drag.current) change(drag.current.value + (drag.current.y - e.clientY) * (max - min) / 160) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
    onKeyDown={e => { if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End'].includes(e.key)) { e.preventDefault(); change(e.key === 'Home' ? min : e.key === 'End' ? max : value + (['ArrowUp', 'ArrowRight'].includes(e.key) ? step : -step)) } }}><i /></div><output>{Number(value.toFixed(2))}{unit}</output></div>
}
