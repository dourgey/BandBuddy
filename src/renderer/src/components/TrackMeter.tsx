import { useEffect, useRef } from 'react'
import { subscribeTrackLevel } from '../track-levels.js'
export function TrackMeter({ id, livePeak }: { id: string; livePeak?: number }): React.JSX.Element {
  const bar = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const paint = (peak: number): void => { if (bar.current) { bar.current.style.transform = `scaleY(${peak <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60))})`; bar.current.dataset.clip = String(peak >= .99) } }
    if (livePeak !== undefined) { paint(livePeak); return }
    paint(0); return subscribeTrackLevel(id, paint)
  }, [id, livePeak])
  return <span className="track-level-meter" aria-label="轨道实时电平"><span ref={bar} /></span>
}
