import { useResolvedTheme, themeColor } from '../appearance.js'
import { memo, useEffect, useRef, useState } from 'react'
import { meterLength } from './generator.js'
import type { ExerciseConfig, MusicEvent } from './types.js'
import type { Tuning } from './theory.js'
interface Props {
  events: MusicEvent[]
  tuning: Tuning
  config: ExerciseConfig
  onSelect: (event: MusicEvent) => void
}
export const Score = memo(function Score({ events, tuning, config, onSelect }: Props): React.JSX.Element {
  const theme = useResolvedTheme()
  const host = useRef<HTMLDivElement>(null)
  const callback = useRef(onSelect)
  callback.current = onSelect
  const [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [availableWidth, setAvailableWidth] = useState(0)
  useEffect(() => {
    const container = host.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let cancelled = false
    const container = host.current
    if (!container) return
    setReady(false)
    setError('')
    void (async () => {
      const V = await import('vexflow/bravura')
      await document.fonts.ready
      if (cancelled) return
      container.replaceChildren()
      const length = meterLength(config.meter)
      const bars = Math.ceil((events.at(-1)!.beat + events.at(-1)!.duration - 1e-6) / length)
      const rhythm = config.pattern === 'rhythm'
      const maxNotes = Math.max(
        ...Array.from(
          { length: bars },
          (_, b) =>
            events.filter((e) => e.beat >= b * length - 1e-6 && e.beat < (b + 1) * length - 1e-6).length
        )
      )
      const width = Math.max(maxNotes > 12 ? 680 : 360, availableWidth || container.clientWidth || 660)
      const columns = width >= 760 && maxNotes <= 10 ? 2 : 1,
        barWidth = width / columns,
        rowHeight = rhythm ? 195 : tuning.notes.length * 17 + 140
      const renderer = new V.Renderer(container, V.Renderer.Backends.SVG)
      renderer.resize(width, Math.ceil(bars / columns) * rowHeight)
      const ctx = renderer.getContext()
      const ink = themeColor('--score-ink', '#29231c'), muted = themeColor('--score-muted', '#81735f')
      ctx.setFont('Academico', 11)
      ctx.setFillStyle(ink)
      ctx.setStrokeStyle(ink)
      for (let bar = 0; bar < bars; bar++) {
        const group = events.filter(
          (e) => e.beat >= bar * length - 1e-6 && e.beat < (bar + 1) * length - 1e-6
        )
        const x = (bar % columns) * barWidth + 5,
          y = Math.floor(bar / columns) * rowHeight + 75
        const stave = rhythm
          ? new V.Stave(x, y, barWidth - 12, { numLines: 1 })
          : new V.TabStave(x, y, barWidth - 12, { numLines: tuning.notes.length, spacingBetweenLinesPx: 17 })
        if (bar === 0) stave.addClef(rhythm ? 'percussion' : 'tab').addTimeSignature(config.meter)
        stave.setStyle({ fillStyle: ink, strokeStyle: ink }).setContext(ctx).draw()
        // VexFlow modifiers change the shared context's font while drawing.
        ctx.setFont('Academico', 11)
        ctx.setFillStyle(muted)
        ctx.fillText(String(bar + 1), x + 5, y - 3)
        const triplets: InstanceType<typeof V.Tuplet>[] = []
        const notes = group.map((e) => {
          const triplet = Math.abs(e.duration - 1 / 3) < 0.001 || Math.abs(e.duration - 1 / 6) < 0.001
          let duration = triplet
            ? e.duration > 0.2
              ? '8'
              : '16'
            : e.duration >= 4
              ? 'w'
              : e.duration >= 2
                ? 'h'
                : e.duration >= 1
                  ? 'q'
                  : e.duration >= 0.5
                    ? '8'
                    : '16'
          // Compound-pulse subdivisions use dotted values, not mislabeled triplets.
          const dotted = [3, 1.5, 0.75, 0.375].some((n) => Math.abs(n - e.duration) < 0.001)
          if (dotted)
            duration = e.duration >= 3 ? 'h' : e.duration >= 1.5 ? 'q' : e.duration >= 0.75 ? '8' : '16'
          const rest = e.notes.length === 0
          const note =
            rest || rhythm
              ? new V.StaveNote({
                  keys: [rhythm ? 'f/5' : 'b/4'],
                  duration: duration + (rest ? 'r' : 's'),
                  dots: dotted ? 1 : 0
                })
              : new V.TabNote(
                  {
                    positions: e.notes.map((p) => ({
                      str: p.string,
                      fret: e.technique === 'mute' ? 'X' : p.fret
                    })),
                    duration,
                    dots: dotted ? 1 : 0
                  },
                  true
                )
          if (dotted) V.Dot.buildAndAttach([note], { all: true })
          note.setStyle({ fillStyle: ink, strokeStyle: ink })
          note.setAttribute('id', `ws-note-${e.id}`)
          if (e.bend)
            note.addModifier(new V.Bend([{ type: V.Bend.UP, text: e.bend === 2 ? 'full' : '½' }]), 0)
          if (e.technique === 'vibrato') note.addModifier(new V.Vibrato(), 0)
          if (e.technique === 'up' || e.technique === 'down')
            note.addModifier(new V.Annotation(e.technique === 'up' ? '↑' : '↓').setFont('Academico', 11), 0)
          const marks = [
            e.accent ? '>' : '',
            e.palmMute ? 'P.M.' : '',
            e.technique === 'tap' ? 'T' : ''
          ].filter(Boolean)
          if (marks.length) note.addModifier(new V.Annotation(marks.join(' ')).setFont('Academico', 11), 0)
          return note
        })
        for (let i = 0; i < group.length; ) {
          if (
            Math.abs(group[i]!.duration - 1 / 3) < 0.001 &&
            i + 2 < notes.length &&
            group.slice(i, i + 3).every((e) => Math.abs(e.duration - 1 / 3) < 0.001)
          ) {
            triplets.push(
              new V.Tuplet(notes.slice(i, i + 3), { numNotes: 3, notesOccupied: 2, bracketed: true })
            )
            i += 3
          } else i++
        }
        const voice = new V.Voice(config.meter).setMode(V.Voice.Mode.SOFT).addTickables(notes)
        new V.Formatter().joinVoices([voice]).format([voice], barWidth - (bar === 0 ? 100 : 38))
        voice.draw(ctx, stave)
        triplets.forEach((t) => t.setContext(ctx).draw())
        for (let i = 0; i < notes.length - 1; i++) {
          const e = group[i]!,
            next = group[i + 1]!
          if (!e.notes.length || !next.notes.length) continue
          const pair = { firstNote: notes[i]!, lastNote: notes[i + 1]!, firstIndexes: [0], lastIndexes: [0] }
          if (e.technique === 'hammer') V.TabTie.createHammeron(pair).setContext(ctx).draw()
          if (e.technique === 'pull') V.TabTie.createPulloff(pair).setContext(ctx).draw()
          if (e.technique === 'slide') new V.TabSlide(pair).setContext(ctx).draw()
          if (next.tie) new V.TabTie(pair).setContext(ctx).draw()
        }
        group.forEach((e) => {
          const element =
            container.querySelector(`#vf-ws-note-${e.id}`) ?? container.querySelector(`#ws-note-${e.id}`)
          if (element) {
            element.setAttribute('data-event', e.id)
            element.classList.add('ws-score-note')
            element.setAttribute('role', 'button')
            element.setAttribute('tabindex', '0')
            element.setAttribute(
              'aria-label',
              e.notes.length
                ? `第${bar + 1}小节 ${e.notes.map((p) => `${p.string}弦${p.fret}品`).join('，')}`
                : `第${bar + 1}小节 休止`
            )
            element.addEventListener('click', () => callback.current(e))
            element.addEventListener('keydown', (event) => {
              if ((event as KeyboardEvent).key === 'Enter') callback.current(e)
            })
          }
        })
      }
      if (!cancelled) setReady(true)
    })().catch((e) => {
      if (!cancelled) {
        setError(`谱面暂时无法渲染：${e instanceof Error ? e.message : String(e)}`)
        container.replaceChildren()
      }
    })
    return () => {
      cancelled = true
    }
  }, [events, tuning.notes.length, config.meter, config.pattern, availableWidth, theme])
  return (
    <section className="ws-score-section">
      <div className="ws-panel-heading">
        <div>
          <small>READ & PLAY</small>
          <h3>
            {config.pattern === 'rhythm' ? '节奏谱' : `${tuning.notes.length} 线 TAB`}{' '}
            <span>{config.pattern === 'rhythm' ? '· 保持大拍，听清起音与休止' : '· 弦品与实际音高同步'}</span>
          </h3>
        </div>
        <span className="ws-tag">
          {config.subdivision === 3
            ? '三等分'
            : config.subdivision === 4
              ? '四等分'
              : config.subdivision === 2
                ? '二等分'
                : '每拍一音'}
        </span>
      </div>
      {error ? (
        <p className="ws-error" role="alert">
          {error}
        </p>
      ) : (
        !ready && <p className="ws-muted">正在排版谱例…</p>
      )}
      <div
        ref={host}
        className="ws-score"
        aria-label={config.pattern === 'rhythm' ? '节奏练习谱例' : `${tuning.notes.length}线练习谱例`}
      />
      <p className="ws-notation-key">
        上方为第 1 弦 · 数字为相对品位 · 0 空弦 · X 闷音 · h 击弦 · p 勾弦 · 斜线 滑音 · full 全音推弦 · 弧线
        延音／连奏 · ↑↓ 拨弦方向 · P.M. 掌根制音（保留音高） · &gt; 重音 · T 右手点弦。点击音符可试听。
      </p>
    </section>
  )
})
