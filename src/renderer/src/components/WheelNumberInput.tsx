import { useEffect, useRef, type InputHTMLAttributes } from 'react'
import { createTempoWheel } from './tempo-wheel.js'

export function WheelNumberInput({ onWheelValue, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  onWheelValue(value: number): void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef({ props, onWheelValue })
  latest.current = { props, onWheelValue }
  useEffect(() => {
    const element = input.current!
    const tempo = createTempoWheel()
    const wheel = (event: WheelEvent): void => {
      const { props: p, onWheelValue: change } = latest.current
      if (p.disabled || p.readOnly || !event.deltaY) return
      event.preventDefault()
      event.stopPropagation()
      const step = Number(p.step) || 1
      const n = Math.max(Number(p.min ?? -Infinity), Math.min(Number(p.max ?? Infinity), Number(p.value) + tempo.delta(event) * step))
      if (Number.isFinite(n)) {
        latest.current.props = { ...p, value: n }
        change(Math.round(n * 1000) / 1000)
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('mouseleave', tempo.reset)
    return () => { element.removeEventListener('wheel', wheel); element.removeEventListener('mouseleave', tempo.reset) }
  }, [])
  return <input {...props} ref={input} />
}
