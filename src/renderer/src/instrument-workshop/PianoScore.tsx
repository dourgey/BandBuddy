import { useResolvedTheme, themeColor } from '../appearance.js'
import { useEffect, useRef, useState } from 'react'
import type { PianoEvent } from './piano.js'
export function PianoScore({ events, active }: { events: PianoEvent[]; active: number }): React.JSX.Element {
  const theme = useResolvedTheme()
  const activeRef = useRef(active)
  activeRef.current = active
  const host = useRef<HTMLDivElement>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void import('vexflow/bravura')
      .then(({ Renderer, Stave, StaveNote, Voice, Formatter, Accidental, StaveConnector }) => {
        if (cancelled || !host.current) return
        host.current.replaceChildren()
        const bars = Math.ceil(events.reduce((n, e) => n + e.duration, 0) / 4),
          width = bars * 330 + 60,
          renderer = new Renderer(host.current, Renderer.Backends.SVG)
        renderer.resize(width, 330)
        const ctx = renderer.getContext()
        const ink = themeColor('--score-ink', '#29231c')
        ctx.setFillStyle(ink)
        ctx.setStrokeStyle(ink)
        for (let bar = 0; bar < bars; bar++) {
          const top = new Stave(20 + bar * 330, 35, 330),
            bottom = new Stave(20 + bar * 330, 175, 330)
          if (bar === 0) {
            top.addClef('treble').addTimeSignature('4/4')
            bottom.addClef('bass').addTimeSignature('4/4')
          }
          top.setStyle({ fillStyle: ink, strokeStyle: ink }).setContext(ctx).draw()
          bottom.setStyle({ fillStyle: ink, strokeStyle: ink }).setContext(ctx).draw()
          new StaveConnector(top, bottom)
            .setType(bar === 0 ? StaveConnector.type.BRACE! : StaveConnector.type.SINGLE_LEFT!)
            .setContext(ctx)
            .draw()
          ctx.setFont('Arial', 11)
          ctx.fillText(String(bar + 1), 28 + bar * 330, 24)
          const slice = events.filter((e) => Math.floor(e.beat / 4) === bar)
          const make = (hand: 'left' | 'right') =>
            slice.map((e) => {
              const pitches = e[hand],
                names = hand === 'left' ? e.names.slice(0, e.left.length) : e.names.slice(e.left.length),
                duration = e.duration === 4 ? 'w' : e.duration === 2 ? 'h' : 'q',
                clef = hand === 'left' ? 'bass' : 'treble'
              const note = new StaveNote({
                clef,
                keys: pitches.length
                  ? names.map((name) => {
                      const m = /^([A-G])([#b]*)(\d)$/.exec(name)!
                      return `${m[1]!.toLowerCase()}${m[2]}/${m[3]}`
                    })
                  : [hand === 'left' ? 'd/3' : 'b/4'],
                duration: duration + (pitches.length ? '' : 'r')
              })
              if (pitches.length)
                names.forEach((name, i) =>
                  note.addModifier(new Accidental(/^([A-G])([#b]*)(\d)$/.exec(name)![2] || 'n'), i)
                )
              return note.setStyle({ fillStyle: ink, strokeStyle: ink })
            })
          const right = make('right'),
            left = make('left'),
            rv = new Voice({ numBeats: 4, beatValue: 4 }).addTickables(right),
            lv = new Voice({ numBeats: 4, beatValue: 4 }).addTickables(left)
          new Formatter()
            .joinVoices([rv])
            .joinVoices([lv])
            .format([rv, lv], bar === 0 ? 205 : 290)
          rv.draw(ctx, top)
          lv.draw(ctx, bottom)
          right.forEach((note, i) => note.getSVGElement()?.setAttribute('data-piano-event', String(slice[i]!.step)))
          left.forEach((note, i) => note.getSVGElement()?.setAttribute('data-piano-event', String(slice[i]!.step)))
        }
        host.current.querySelectorAll('[data-piano-event]').forEach(el => el.classList.toggle('ws-active-note', el.getAttribute('data-piano-event') === String(activeRef.current)))
        setError('')
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [events, theme])
  useEffect(() => {
    host.current
      ?.querySelectorAll('[data-piano-event]')
      .forEach((el) => el.classList.toggle('ws-active-note', el.getAttribute('data-piano-event') === String(active)))
  }, [active])
  return (
    <div className="ws-piano-score">
      <p>大谱表 · 上方右手／下方左手 · 同时起音垂直对齐 · 末小节的休止也计入循环。</p>
      <div ref={host} className="ws-score-scroll" aria-label="钢琴大谱表" />
      {error && <p role="alert">谱面无法加载：{error}</p>}
    </div>
  )
}
