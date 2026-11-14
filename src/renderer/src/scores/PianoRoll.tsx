import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScoreData } from '@shared/scores.js'
import { themeColor, useResolvedTheme } from '../appearance.js'
export const TRACK_COLORS = ['#b27a43','#477f83','#8e709e','#799354','#b65b65','#5384ad','#a28235','#697b96']

export function PianoRoll({ data, trackIds, position, follow, onSeek }: { data: ScoreData; trackIds: string[]; position: number; follow: boolean; onSeek(time: number): void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null), wrapper = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800), [span, setSpan] = useState(16), [offset, setOffset] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const theme = useResolvedTheme()
  const start = follow ? Math.floor(position / span) * span : offset
  const tracks = useMemo(() => trackIds.length ? data.tracks.filter(t => trackIds.includes(t.id)) : data.tracks, [data, trackIds.join(',')])
  const totalHeight = Math.max(310, tracks.length * 106), height = Math.min(560, totalHeight)
  const lane = (totalHeight - 26) / Math.max(1, tracks.length)
  const bounds = useMemo(() => tracks.map((track, index) => {
    let low = 48, high = 72
    for (const n of track.notes) { low = Math.min(low, n.pitch); high = Math.max(high, n.pitch) }
    return { track, index, low, high }
  }), [tracks])
  const lanes = useMemo(() => bounds.slice(Math.max(0, Math.floor(scrollTop / lane) - 1), Math.ceil((scrollTop + height) / lane) + 1)
    .map(row => ({ ...row, visible: row.track.notes.filter(n => n.end >= start && n.start <= start + span) })), [bounds, lane, height, scrollTop, start, span])
  useEffect(() => { const host = wrapper.current; if (!host) return; const r = new ResizeObserver(() => setWidth(Math.max(300, host.clientWidth))); r.observe(host); setWidth(host.clientWidth); return () => r.disconnect() }, [])
  useEffect(() => {
    const node = canvas.current; if (!node) return
    const c = node.getContext('2d'); if (!c) return
    const ratio = window.devicePixelRatio || 1
    node.width = width * ratio; node.height = height * ratio; node.style.height = `${height}px`; c.scale(ratio, ratio)
    const paper = themeColor('--paper-2', '#fbf8f3'), grid = themeColor('--border-soft', '#e9e3da'), text = themeColor('--muted', '#817a71')
    c.fillStyle = paper; c.fillRect(0, 0, width, height); c.font = '11px sans-serif'; c.textBaseline = 'middle'
    const left = 76, scale = (width - left) / span
    for (let second = Math.ceil(start); second <= start + span; second++) {
      const x = left + (second - start) * scale; c.strokeStyle = grid; c.beginPath(); c.moveTo(x, 22); c.lineTo(x, height); c.stroke(); c.fillStyle = text; c.fillText(`${second}s`, x + 3, 10)
    }
    c.save(); c.beginPath(); c.rect(0, 24, width, height - 24); c.clip()
    lanes.forEach(({ track, low, high, visible, index }) => {
      const top = 24 + index * lane - scrollTop, color = TRACK_COLORS[data.tracks.indexOf(track) % TRACK_COLORS.length]!
      c.strokeStyle = grid; c.beginPath(); c.moveTo(0, top + lane); c.lineTo(width, top + lane); c.stroke()
      c.fillStyle = color; c.fillText(track.name.slice(0, 9), 7, top + 13)
      const noteHeight = Math.max(3, Math.min(9, (lane - 30) / (high - low + 1)))
      for (let pitch = low; pitch <= high; pitch++) {
        const y = top + 24 + (high - pitch) / (high - low + 1) * (lane - 31)
        if (tracks.length === 1 || pitch % 12 === 0) {
          c.strokeStyle = grid; c.lineWidth = .5; c.beginPath(); c.moveTo(left, y + noteHeight); c.lineTo(width, y + noteHeight); c.stroke()
          if (pitch % 12 === 0) { c.fillStyle = text; c.fillText(`C${Math.floor(pitch / 12) - 1}`, left - 24, y + noteHeight / 2) }
        }
      }
      for (const n of visible) {
        const x = left + (Math.max(start, n.start) - start) * scale, y = top + 24 + (high - n.pitch) / (high - low + 1) * (lane - 31)
        c.globalAlpha = n.start <= position && n.end > position ? 1 : .7; c.fillStyle = color
        c.fillRect(x, y, Math.max(2, (Math.min(start + span, n.end) - Math.max(start, n.start)) * scale - 1), noteHeight)
      }
      c.globalAlpha = 1
    })
    c.restore()
    if (position >= start && position <= start + span) { const x = left + (position - start) * scale; c.strokeStyle = themeColor('--ink', '#1b1814'); c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, 20); c.lineTo(x, height); c.stroke() }
  }, [data, trackIds.join(','), lanes, height, lane, scrollTop, width, span, start, position, theme])
  return <div className="score-roll" ref={wrapper}>
    <div className="score-roll-tools"><span>时间 / 音高</span><label>视野 <select aria-label="卷帘缩放" value={span} onChange={e => setSpan(Number(e.target.value))}><option value={8}>8 秒</option><option value={16}>16 秒</option><option value={32}>32 秒</option></select></label></div>
    <div style={{ height, overflowY: 'auto' }} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}><div style={{ height: totalHeight }}>
      <canvas style={{ position: 'sticky', top: 0 }} ref={canvas} aria-label="分轨钢琴卷帘，点击定位" role="img" onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); onSeek(Math.max(0, Math.min(data.duration, start + (e.clientX - rect.left - 76) / (width - 76) * span))) }} />
    </div></div>
    {!follow && <input aria-label="卷帘浏览位置" type="range" min={0} max={Math.max(0, data.duration - span)} step={.1} value={offset} onChange={e => setOffset(Number(e.target.value))} />}
  </div>
}
