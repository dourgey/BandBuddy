import { memo, useEffect, useRef, useState } from 'react'
import { useResolvedTheme, themeColor } from '../appearance.js'
import { DRUM_LABELS, measureBeats, type EnsembleEvent, type EnsembleScore as ScoreData } from './ensemble-material.js'

const pitchKey = (midi: number): string => `${['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'][midi % 12]}/${Math.floor(midi / 12) - 1}`
const durations: [number, string][] = [[4, 'w'], [3, 'h'], [2, 'h'], [1.5, 'q'], [1, 'q'], [.75, '8'], [.5, '8'], [.25, '16']]
/** Grand staff uses independent hand timelines. Drum score uses a legend and explicit rhythm grid. */
export const EnsembleScore = memo(function EnsembleScore({ score, drums }: { score: ScoreData; drums: boolean }): React.JSX.Element {
 const theme = useResolvedTheme()
 const host = useRef<HTMLDivElement>(null), [error, setError] = useState('')
 useEffect(() => {
  if (drums || !host.current) return
  let cancelled = false
  const container = host.current
  setError('')
  container.removeAttribute('data-rendered-score')
  void (async () => {
   const V = await import('vexflow/bravura')
   await document.fonts.ready
   if (cancelled) return
   container.replaceChildren()
   const length = measureBeats(score.meter), width = 610
   const renderer = new V.Renderer(container, V.Renderer.Backends.SVG)
   renderer.resize(width, score.bars * 235)
   const ctx = renderer.getContext()
   const ink = themeColor('--score-ink', '#534a40')
   ctx.setFillStyle(ink).setStrokeStyle(ink)
   for (let bar = 0; bar < score.bars; bar++) {
    for (const [hand, clef, y] of [['R', 'treble', 20], ['L', 'bass', 120]] as const) {
     const stave = new V.Stave(10, bar * 235 + y, width - 25)
     stave.addClef(clef)
     if (!bar) stave.addTimeSignature(score.meter)
     stave.setStyle({ fillStyle: ink, strokeStyle: ink }).setContext(ctx).draw()
     const selected = score.events.filter(e => e.hand === hand && e.beat >= bar * length && e.beat < (bar + 1) * length).sort((a, b) => a.beat - b.beat)
     const timeline: { event?: EnsembleEvent; duration: number }[] = []
     let cursor = bar * length
     for (const e of selected) { if (e.beat > cursor + .001) timeline.push({ duration: e.beat - cursor }); timeline.push({ event: e, duration: e.duration }); cursor = e.beat + e.duration }
     if (cursor < (bar + 1) * length - .001) timeline.push({ duration: (bar + 1) * length - cursor })
     const refs: { id?: string; note: InstanceType<typeof V.StaveNote> }[] = []
     for (const item of timeline) {
      let remaining = item.duration
      while (remaining > .001) {
       const [beats, symbol] = durations.find(([d]) => d <= remaining + .001) ?? [.25, '16']
       const notes = item.event?.notes ?? [], rest = !notes.length
       const note = new V.StaveNote({ clef, keys: rest ? [clef === 'bass' ? 'd/3' : 'b/4'] : notes.map(pitchKey), duration: symbol + (rest ? 'r' : '') })
       note.setStyle({ fillStyle: ink, strokeStyle: ink })
       note.getStem()?.setStyle({ fillStyle: ink, strokeStyle: ink })
       if ([3, 1.5, .75].includes(beats)) V.Dot.buildAndAttach([note])
       notes.forEach((midi, i) => { if (pitchKey(midi).includes('#')) note.addModifier(new V.Accidental('#'), i) })
       refs.push({ id: item.event?.id, note }); remaining -= beats
      }
     }
     V.Formatter.FormatAndDraw(ctx, stave, refs.map(r => r.note))
     refs.forEach(({ id, note }) => { if (id) note.getSVGElement()?.setAttribute('data-ensemble-event', id) })
     ctx.setFont('Arial', 11); ctx.fillText(`${bar + 1} · ${hand === 'R' ? '右手' : '左手'}`, 16, bar * 235 + y + 5)
    }
   }
   container.setAttribute('data-rendered-score', score.name)
  })().catch(e => { if (!cancelled) setError(`谱面无法显示：${e instanceof Error ? e.message : String(e)}`) })
  return () => { cancelled = true }
 }, [score, drums, theme])
 if (drums) {
  const voices = [...new Set(score.events.map(e => e.drum).filter((d): d is NonNullable<typeof d> => !!d))]
  const length = measureBeats(score.meter), steps = Math.round(length * 4)
  return <div className="ensemble-score ensemble-drum-score" aria-label="鼓组节奏谱">
   <p>每格为十六分音符；● 击打，○ 轻击，空格为休止；R 右手，L 左手。{score.meter} 拍</p>
   {Array.from({ length: score.bars }, (_, bar) => <div className="ensemble-grid-scroll" key={bar}><table><caption>第 {bar + 1} 小节</caption><thead><tr><th>鼓件</th>{Array.from({ length: steps }, (_, i) => <th key={i}>{score.meter.endsWith('/8') ? i % 2 === 0 ? i / 2 + 1 : '&' : i % 4 === 0 ? i / 4 + 1 : ['e', '&', 'a'][i % 4 - 1]}</th>)}</tr></thead><tbody>
    {voices.map(drum => <tr key={drum}><th>{DRUM_LABELS[drum]}</th>{Array.from({ length: steps }, (_, i) => {
     const e = score.events.find(e => e.drum === drum && Math.abs(e.beat - (bar * length + i / 4)) < .001)
     return <td key={i} data-ensemble-event={e?.id}>{e ? <><b>{e.velocity < .4 ? '○' : '●'}</b><small>{e.label}</small></> : '·'}</td>
    })}</tr>)}
   </tbody></table></div>)}
  </div>
 }
 return <div className="ensemble-score" aria-label="钢琴大谱表"><div ref={host} />{error && <p role="alert">{error}</p>}</div>
})
