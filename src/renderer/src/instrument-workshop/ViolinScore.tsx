import { useResolvedTheme, themeColor } from '../appearance.js'
import { useEffect, useRef, useState } from 'react'
import type { LabEvent } from './ensemble.js'
import { noteName } from './theory.js'
/** Standard treble notation, explicitly separate from fretted instrument TAB. */
export function ViolinScore({ events, active }: { events: LabEvent[]; active: number }): React.JSX.Element {
  const theme = useResolvedTheme()
  const activeRef = useRef(active)
  activeRef.current = active
  const host = useRef<HTMLDivElement>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void import('vexflow/bravura')
      .then(({ Renderer, Stave, StaveNote, Voice, Formatter, Accidental, Annotation }) => {
        if (cancelled || !host.current) return
        host.current.replaceChildren()
        const count = events.length,
          width = Math.max(500, count * 75 + 100),
          renderer = new Renderer(host.current, Renderer.Backends.SVG)
        renderer.resize(width, 200)
        const context = renderer.getContext(),
          stave = new Stave(10, 50, width - 20)
        const ink = themeColor('--score-ink', '#29231c')
        context.setFillStyle(ink)
        context.setStrokeStyle(ink)
        stave.setStyle({ fillStyle: ink, strokeStyle: ink }).addClef('treble').setContext(context).draw()
        const notes = events.map((e) => {
          const name = e.name ?? noteName(e.midi!),
            m = /^([A-G])([#b]*)(\d)$/.exec(name)!,
            duration = e.duration === 4 ? 'w' : e.duration === 2 ? 'h' : 'q'
          const note = new StaveNote({ keys: [`${m[1]!.toLowerCase()}${m[2]}/${m[3]}`], duration })
          note.addModifier(new Accidental(m[2] || 'n'), 0)
          note.addModifier(
            new Annotation(e.bow === '下弓' ? '下弓' : '上弓').setVerticalJustification(Annotation.VerticalJustify.TOP),
            0
          )
          return note.setStyle({ fillStyle: ink, strokeStyle: ink })
        })
        const voice = new Voice({ numBeats: events.reduce((n, e) => n + e.duration, 0), beatValue: 4 }).addTickables(
          notes
        )
        new Formatter().joinVoices([voice]).format([voice], width - 125)
        voice.draw(context, stave)
        notes.forEach((note, i) => note.getSVGElement()?.setAttribute('data-violin-note', String(i)))
        host.current.querySelectorAll('[data-violin-note]').forEach(el => el.classList.toggle('ws-active-note', el.getAttribute('data-violin-note') === String(activeRef.current)))
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
      ?.querySelectorAll('[data-violin-note]')
      .forEach((el) => el.classList.toggle('ws-active-note', el.getAttribute('data-violin-note') === String(active)))
  }, [active])
  return (
    <div className="ws-violin-score">
      <p>
        高音谱号 · 实际音高 ·{' '}
        {events[0]?.duration === 4 ? '全音符' : events[0]?.duration === 2 ? '二分音符' : '四分音符'} ·
        每音分弓。此处是连续练习句；上方节拍单位为四分音符。
      </p>
      <div className="ws-score-scroll" ref={host} aria-label="小提琴五线谱" />
      {error && <p role="alert">谱面无法加载：{error}</p>}
    </div>
  )
}
