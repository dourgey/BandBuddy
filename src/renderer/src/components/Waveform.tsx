import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import type { StemType } from '@shared/domain.js'
import { clamp } from '../utils.js'

interface PeaksData { min: number[]; max: number[] }

function isPeaksData(value: unknown): value is PeaksData {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PeaksData>
  return Array.isArray(candidate.min) && Array.isArray(candidate.max) && candidate.min.length > 0 && candidate.max.length > 0
}

export function Waveform({
  peaksUrl,
  color,
  durationMs,
  currentMs,
  loopStartMs,
  loopEndMs,
  zoom,
  scroll,
  disabled,
  onSeek,
  onRange,
  onViewChange
}: {
  stemType: StemType
  peaksUrl: string | null
  color: string
  durationMs: number
  currentMs: number
  loopStartMs: number | null
  loopEndMs: number | null
  zoom: number
  scroll: number
  disabled?: boolean
  onSeek(milliseconds: number): void
  onRange(startMs: number, endMs: number): void
  onViewChange(zoom: number, scroll: number): void
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const wave = useRef<WaveSurfer | null>(null)
  const dragStart = useRef<number | null>(null)
  const zoomRef = useRef(zoom)
  const scrollRef = useRef(scroll)
  const onViewChangeRef = useRef(onViewChange)
  const [loadFailed, setLoadFailed] = useState(false)

  zoomRef.current = zoom
  scrollRef.current = scroll
  onViewChangeRef.current = onViewChange

  useEffect(() => {
    const viewport = container.current
    if (!viewport || disabled) return
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const currentZoom = zoomRef.current
      const visibleSpan = 1 / Math.max(1, currentZoom)
      const visibleStart = clamp(scrollRef.current, 0, 1) * (1 - visibleSpan)
      const bounds = viewport.getBoundingClientRect()
      const pointer = clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      const anchor = visibleStart + pointer * visibleSpan
      const nextZoom = clamp(currentZoom * Math.exp(-event.deltaY * 0.0025), 1, 100)
      if (Math.abs(nextZoom - currentZoom) < 0.001) return
      const nextSpan = 1 / nextZoom
      const nextStart = clamp(anchor - pointer * nextSpan, 0, 1 - nextSpan)
      const nextScroll = nextZoom <= 1 ? 0 : nextStart / (1 - nextSpan)
      onViewChangeRef.current(nextZoom, clamp(nextScroll, 0, 1))
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [disabled])

  useEffect(() => {
    if (!container.current || !peaksUrl || durationMs <= 0) return
    let cancelled = false
    setLoadFailed(false)
    void fetch(peaksUrl).then(async (response) => {
      if (!response.ok) throw new Error(`PEAKS_HTTP_${response.status}`)
      const data: unknown = await response.json()
      if (!isPeaksData(data)) throw new Error('PEAKS_INVALID')
      return data
    }).then((data) => {
      if (cancelled || !container.current) return
      const points = Float32Array.from(data.max, (max, index) => {
        const min = data.min[index] ?? 0
        return Math.abs(max) >= Math.abs(min) ? max / 32767 : min / 32767
      })
      wave.current = WaveSurfer.create({
        container: container.current,
        height: Math.max(1, container.current.clientHeight),
        waveColor: `${color}78`,
        progressColor: `${color}78`,
        cursorWidth: 0,
        normalize: false,
        interact: false,
        hideScrollbar: true,
        fillParent: false,
        minPxPerSec: Math.max(1, container.current.clientWidth * zoomRef.current / (durationMs / 1000)),
        peaks: [points],
        duration: durationMs / 1000
      })
      const visibleStart = clamp(scrollRef.current, 0, 1) * Math.max(0, 1 - 1 / zoomRef.current)
      wave.current.setScrollTime(visibleStart * durationMs / 1000)
    }).catch(() => { if (!cancelled) setLoadFailed(true) })
    return () => {
      cancelled = true
      wave.current?.destroy()
      wave.current = null
    }
  }, [peaksUrl, durationMs, color])

  useEffect(() => {
    if (!wave.current || !container.current || durationMs <= 0) return
    const syncSize = (): void => {
      if (!wave.current || !container.current) return
      wave.current.setOptions({ height: Math.max(1, container.current.clientHeight) })
      wave.current.zoom(Math.max(1, container.current.clientWidth * zoom / (durationMs / 1000)))
      const visibleStart = clamp(scrollRef.current, 0, 1) * Math.max(0, 1 - 1 / zoomRef.current)
      wave.current.setScrollTime(visibleStart * durationMs / 1000)
    }
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [durationMs, zoom])

  useEffect(() => {
    if (!wave.current || durationMs <= 0) return
    const start = clamp(scroll, 0, 1) * Math.max(0, 1 - 1 / zoom)
    wave.current.setScrollTime(start * durationMs / 1000)
  }, [durationMs, scroll, zoom])

  const visibleSpan = 1 / Math.max(1, zoom)
  const visibleStart = clamp(scroll, 0, 1) * (1 - visibleSpan)
  const toScreen = (fractionValue: number): number => ((fractionValue - visibleStart) / visibleSpan) * 100
  const position = durationMs ? toScreen(clamp(currentMs / durationMs, 0, 1)) : 0
  const rangeLeft = loopStartMs !== null && durationMs ? toScreen(clamp(loopStartMs / durationMs, 0, 1)) : null
  const rangeRight = loopEndMs !== null && durationMs ? toScreen(clamp(loopEndMs / durationMs, 0, 1)) : null

  const fraction = (clientX: number): number => {
    const bounds = container.current!.getBoundingClientRect()
    return clamp(visibleStart + ((clientX - bounds.left) / bounds.width) * visibleSpan, 0, 1)
  }

  return <div
    ref={container}
    className={`waveform ${disabled ? 'is-disabled' : ''}`}
    style={{ color }}
    onPointerDown={(event) => {
      if (disabled) return
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStart.current = fraction(event.clientX)
    }}
    onPointerUp={(event) => {
      if (disabled || dragStart.current === null) return
      const end = fraction(event.clientX)
      const start = dragStart.current
      dragStart.current = null
      if (Math.abs(end - start) > 0.015) onRange(Math.min(start, end) * durationMs, Math.max(start, end) * durationMs)
      else onSeek(end * durationMs)
    }}
  >
    {(!peaksUrl || loadFailed) && <div className="waveform-placeholder">{Array.from({ length: 72 }, (_, index) => <i key={index} style={{ height: `${12 + ((index * 19) % 35)}%` }} />)}</div>}
    {rangeLeft !== null && rangeRight !== null && rangeRight >= 0 && rangeLeft <= 100 && <div className="wave-range" style={{ left: `${clamp(rangeLeft, 0, 100)}%`, width: `${clamp(rangeRight, 0, 100) - clamp(rangeLeft, 0, 100)}%` }} />}
    {position >= 0 && position <= 100 && <div className="wave-cursor" style={{ left: `${position}%` }} />}
  </div>
}
