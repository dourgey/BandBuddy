import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import type { RecordingMeter, StemType } from '@shared/domain.js'
import { acquireWaveformPeaks } from '../waveform-peaks.js'
import { themeColor, useResolvedTheme } from '../appearance.js'
import { usePlayerStore } from '../player-store.js'
import { clamp } from '../utils.js'

export interface LiveWaveformInput {
  sessionId: string | null
  active: boolean
  meter: RecordingMeter
}

export function Waveform({
  peaksUrl,
  stemType,
  color: fallbackColor,
  durationMs,
  currentMs,
  loopStartMs,
  loopEndMs,
  zoom,
  scroll,
  disabled,
  live,
  onSeek,
  onRange,
  onViewChange
}: {
  stemType: StemType | 'recording'
  peaksUrl: string | null
  color: string
  durationMs: number
  currentMs?: number
  loopStartMs: number | null
  loopEndMs: number | null
  zoom: number
  scroll: number
  disabled?: boolean
  live?: LiveWaveformInput
  onSeek(milliseconds: number): void
  onRange(startMs: number, endMs: number): void
  onViewChange(zoom: number, scroll: number): void
}): React.JSX.Element {
  const theme = useResolvedTheme()
  const color = useMemo(() => themeColor(`--stem-${stemType}`, fallbackColor), [theme, stemType, fallbackColor])
  const faded = (value: string): string => /^#[a-f\d]{6}$/i.test(value) ? `${value}78` : value
  const container = useRef<HTMLDivElement>(null)
  const liveCanvas = useRef<HTMLCanvasElement>(null)
  const livePeaks = useRef(new Float32Array(32768))
  const liveRevision = useRef(0)
  const drawn = useRef({ signature: '', revision: -1, columns: new Float32Array(0) })
  const cursor = useRef<HTMLDivElement>(null)
  const liveSessionId = useRef<string | null>(null)
  const wave = useRef<WaveSurfer | null>(null)
  const latestColor = useRef(color)
  latestColor.current = color
  const dragStart = useRef<number | null>(null)
  const zoomRef = useRef(zoom)
  const scrollRef = useRef(scroll)
  const onViewChangeRef = useRef(onViewChange)
  const [loadFailed, setLoadFailed] = useState(false)
  const appliedHeight = useRef(0)

  zoomRef.current = zoom
  scrollRef.current = scroll
  onViewChangeRef.current = onViewChange

  const drawLiveWaveform = useCallback((changedBucket?: number): void => {
    const canvas = liveCanvas.current
    const viewport = container.current
    if (!canvas || !viewport) return
    const width = Math.max(1, viewport.clientWidth)
    const height = Math.max(1, viewport.clientHeight)
    const scale = Math.max(1, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(scale, 0, 0, scale, 0, 0)
    if (durationMs <= 0) return
    const visibleSpan = 1 / Math.max(1, zoom)
    const visibleStart = clamp(scroll, 0, 1) * (1 - visibleSpan)
    const signature = `${width}|${height}|${scale}|${durationMs}|${zoom}|${scroll}|${color}`
    const incremental = changedBucket !== undefined && drawn.current.signature === signature && drawn.current.revision === liveRevision.current
    const columns = incremental ? drawn.current.columns : new Float32Array(Math.ceil(width) + 1)
    const project = (bucket: number): number => Math.round(((bucket / (livePeaks.current.length - 1) - visibleStart) / visibleSpan) * width)
    let first = 0, last = columns.length - 1
    if (incremental) {
      const column = project(changedBucket)
      if (column < 0 || column >= columns.length) return
      columns[column] = Math.max(columns[column]!, livePeaks.current[changedBucket]!)
      first = last = column
      context.clearRect(column, 0, 1, height)
    } else {
      context.clearRect(0, 0, width, height)
      for (let bucket = 0; bucket < livePeaks.current.length; bucket++) {
        const column = project(bucket)
        if (column >= 0 && column < columns.length) columns[column] = Math.max(columns[column]!, livePeaks.current[bucket]!)
      }
      drawn.current = { signature, revision: liveRevision.current, columns }
    }
    context.strokeStyle = color
    context.globalAlpha = 0.82
    context.lineWidth = 1
    context.beginPath()
    const middle = height / 2
    for (let column = first; column <= last; column += 1) {
      const amplitude = columns[column] ?? 0
      if (amplitude <= 0) continue
      const halfHeight = Math.max(1, Math.min(height * 0.48, amplitude * height * 0.48))
      context.moveTo(column + 0.5, middle - halfHeight)
      context.lineTo(column + 0.5, middle + halfHeight)
    }
    context.stroke()
    context.globalAlpha = 1
  }, [color, durationMs, scroll, zoom])

  useEffect(() => {
    if (!live) {
      if (liveSessionId.current) {
        liveSessionId.current = null
        livePeaks.current.fill(0)
        liveRevision.current++
        drawLiveWaveform()
      }
      return
    }
    if (live.sessionId && liveSessionId.current !== live.sessionId) {
      liveSessionId.current = live.sessionId
      livePeaks.current.fill(0)
      liveRevision.current++
    }
    if (live.active && live.meter.recording && Number.isFinite(live.meter.sourcePositionMs)) {
      const amplitude = Math.max(...live.meter.peak, ...live.meter.rms, 0)
      const positionMs = clamp(live.meter.sourcePositionMs, 0, durationMs)
      const bucket = Math.round((positionMs / Math.max(1, durationMs)) * (livePeaks.current.length - 1))
      livePeaks.current[bucket] = Math.max(livePeaks.current[bucket]!, amplitude)
      drawLiveWaveform(bucket)
    } else drawLiveWaveform()
  }, [drawLiveWaveform, durationMs, live])

  useEffect(() => {
    if (peaksUrl && !live?.active) {
      livePeaks.current.fill(0)
      liveRevision.current++
      drawLiveWaveform()
    }
  }, [drawLiveWaveform, live?.active, peaksUrl])

  useEffect(() => {
    const viewport = container.current
    if (!viewport || disabled) return
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      // Shift + wheel scrolls the view; a bare wheel keeps zooming around the pointer.
      if (event.shiftKey) {
        onViewChangeRef.current(zoomRef.current, clamp(scrollRef.current + (event.deltaY + event.deltaX) * 0.0016, 0, 1))
        return
      }
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

  // Keeps the waveform's time axis equal to the container width. The playhead is placed as a
  // percentage of the container, so a pxPerSec left over from an older width misplaces it.
  const syncSize = useCallback((): void => {
    const instance = wave.current
    const viewport = container.current
    if (!instance || !viewport || durationMs <= 0) return
    const height = Math.max(1, viewport.clientHeight)
    if (appliedHeight.current !== height) {
      appliedHeight.current = height
      instance.setOptions({ height })
    }
    instance.zoom(Math.max(1, viewport.clientWidth * zoom / (durationMs / 1000)))
    const visibleStart = clamp(scrollRef.current, 0, 1) * Math.max(0, 1 - 1 / zoom)
    instance.setScrollTime(visibleStart * durationMs / 1000)
  }, [durationMs, zoom])

  useEffect(() => {
    if (!container.current || !peaksUrl || durationMs <= 0) return
    let cancelled = false
    setLoadFailed(false)
    const lease = acquireWaveformPeaks(peaksUrl)
    void lease.promise.then((points) => {
      if (cancelled || !container.current) return
      wave.current = WaveSurfer.create({
        container: container.current,
        height: Math.max(1, container.current.clientHeight),
        waveColor: faded(latestColor.current),
        progressColor: faded(latestColor.current),
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
      lease.release()
      wave.current?.destroy()
      wave.current = null
    }
  }, [peaksUrl, durationMs])

  useEffect(() => {
    wave.current?.setOptions({ waveColor: faded(color), progressColor: faded(color) })
  }, [color])

  useEffect(() => {
    const viewport = container.current
    if (!viewport) return
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [syncSize])

  useEffect(() => {
    drawLiveWaveform()
    const viewport = container.current
    if (!viewport) return
    const observer = new ResizeObserver(() => drawLiveWaveform())
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [drawLiveWaveform])

  useEffect(() => {
    if (!wave.current || durationMs <= 0) return
    const start = clamp(scroll, 0, 1) * Math.max(0, 1 - 1 / zoom)
    wave.current.setScrollTime(start * durationMs / 1000)
  }, [durationMs, scroll, zoom])

  const visibleSpan = 1 / Math.max(1, zoom)
  const visibleStart = clamp(scroll, 0, 1) * (1 - visibleSpan)
  const toScreen = (fractionValue: number): number => ((fractionValue - visibleStart) / visibleSpan) * 100
  const position = durationMs ? toScreen(clamp((currentMs ?? usePlayerStore.getState().currentMs) / durationMs, 0, 1)) : 0
  const rangeLeft = loopStartMs !== null && durationMs ? toScreen(clamp(loopStartMs / durationMs, 0, 1)) : null
  const rangeRight = loopEndMs !== null && durationMs ? toScreen(clamp(loopEndMs / durationMs, 0, 1)) : null

  useEffect(() => {
    const update = (milliseconds: number): void => {
      const element = cursor.current
      if (!element) return
      const next = durationMs ? ((milliseconds / durationMs - visibleStart) / visibleSpan) * 100 : 0
      element.style.left = `${next}%`
      element.style.display = next >= 0 && next <= 100 ? '' : 'none'
    }
    update(currentMs ?? usePlayerStore.getState().currentMs)
    if (currentMs !== undefined) return
    return usePlayerStore.subscribe((state, previous) => { if (state.currentMs !== previous.currentMs) update(state.currentMs) })
  }, [currentMs, durationMs, visibleStart, visibleSpan])

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
    <canvas ref={liveCanvas} className="live-waveform" aria-hidden="true" />
    {rangeLeft !== null && rangeRight !== null && rangeRight >= 0 && rangeLeft <= 100 && <div className="wave-range" style={{ left: `${clamp(rangeLeft, 0, 100)}%`, width: `${clamp(rangeRight, 0, 100) - clamp(rangeLeft, 0, 100)}%` }} />}
    <div ref={cursor} className="wave-cursor" style={{ left: `${position}%`, display: position >= 0 && position <= 100 ? undefined : 'none' }} />
  </div>
}
