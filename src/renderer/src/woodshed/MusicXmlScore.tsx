import { memo, useEffect, useRef, useState } from 'react'
import type { OpenSheetMusicDisplay, VexFlowGraphicalNote } from 'opensheetmusicdisplay'
import { themeColor, useResolvedTheme } from '../appearance.js'
import type { ScoreAnchor } from './musicxml.js'
import './musicxml.css'

export interface MusicXmlScoreProps {
  xml: string
  label: string
  className?: string
  anchors?: ScoreAnchor[]
  eventAttribute?: 'data-event' | 'data-ensemble-event'
  onSelect?: (eventId: string) => void
}

/** Shared MusicXML reader for both authored lessons and generated practice material. */
export const MusicXmlScore = memo(function MusicXmlScore({ xml, label, className = '', anchors, eventAttribute = 'data-event', onSelect }: MusicXmlScoreProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null)
  const callback = useRef(onSelect)
  callback.current = onSelect
  const theme = useResolvedTheme()
  const [state, setState] = useState<{ ready: boolean; error: string }>({ ready: false, error: '' })
  useEffect(() => {
    const container = host.current, wrapper = viewport.current
    if (!container || !wrapper) return
    let disposed = false, score: OpenSheetMusicDisplay | undefined, frame = 0, lastWidth = 0
    setState({ ready: false, error: '' })
    wrapper.removeAttribute('data-rendered-score')
    // Graphical timestamps and XML voice IDs remain stable across layout changes.
    function attachEvents(): void {
      if (!score || !anchors?.length) return
      const byTime = new Map<string, ScoreAnchor[]>()
      for (const anchor of anchors) {
        const key = `${anchor.staff}:${anchor.voice}:${Math.round(anchor.beat * 480)}`
        byTime.set(key, [...(byTime.get(key) ?? []), anchor])
      }
      const tagged = new Set<Element>()
      for (const measure of score.GraphicSheet.MeasureList) {
        measure.forEach((staff, staffIndex) => {
          for (const entry of staff.staffEntries) for (const voice of entry.graphicalVoiceEntries) for (const note of voice.notes) {
            const source = note.sourceNote
            const key = `${staffIndex + 1}:${source.ParentVoiceEntry.ParentVoice.VoiceId}:${Math.round(source.getAbsoluteTimestamp().RealValue * 4 * 480)}`
            const candidates = byTime.get(key)
            if (!candidates?.length) continue
            const anchor = candidates.find(a => !a.instrument || a.instrument === source.PlaybackInstrumentId)
            if (!anchor) continue
            const graphical = note as VexFlowGraphicalNote
            // Simultaneous drum hits have independent playback events.
            const element = anchor.instrument ? graphical.getNoteheadSVGs()[graphical.vfnoteIndex] : graphical.getSVGGElement()
            if (!element || tagged.has(element)) continue
            tagged.add(element)
            element.setAttribute(eventAttribute, anchor.id)
            element.classList.add('ws-score-note')
            element.setAttribute('aria-label', anchor.label || label)
            if (callback.current) {
              element.setAttribute('role', 'button')
              element.setAttribute('tabindex', '0')
              element.addEventListener('click', () => callback.current?.(anchor.id))
              element.addEventListener('keydown', event => {
                const key = (event as KeyboardEvent).key
                if (key === 'Enter' || key === ' ') { event.preventDefault(); callback.current?.(anchor.id) }
              })
            }
          }
        })
      }
    }
    function fail(error: unknown): void {
      if (disposed) return
      container!.replaceChildren()
      wrapper!.removeAttribute('data-rendered-score')
      setState({ ready: false, error: `谱面暂时无法显示：${error instanceof Error ? error.message : String(error)}` })
    }
    function render(): void {
      if (disposed || !score?.IsReadyToRender()) return
      const width = Math.max(340, Math.floor(wrapper!.clientWidth))
      container!.style.width = `${width}px`
      try {
        const playing = new Set(Array.from(container!.querySelectorAll(`[${eventAttribute}].active, [${eventAttribute}].ensemble-active`), n => n.getAttribute(eventAttribute)))
        score.render()
        attachEvents()
        for (const note of container!.querySelectorAll(`[${eventAttribute}]`)) if (playing.has(note.getAttribute(eventAttribute))) note.classList.add(eventAttribute === 'data-event' ? 'active' : 'ensemble-active')
        lastWidth = width
        wrapper!.setAttribute('data-rendered-score', label)
        setState({ ready: true, error: '' })
      } catch (error) { fail(error) }
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (Math.abs(Math.max(340, Math.floor(wrapper.clientWidth)) - lastWidth) < 2) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(render)
    })
    resize?.observe(wrapper)
    void (async () => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml')
      if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'score-partwise') throw new Error('请提供有效的 MusicXML 分部总谱文档')
      const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay')
      await document.fonts?.ready
      if (disposed) return
      container.replaceChildren()
      score = new OpenSheetMusicDisplay(container, {
        backend: 'svg', autoResize: false, drawingParameters: 'compacttight',
        drawTitle: false, drawSubtitle: false, drawComposer: false, drawCredits: false,
        drawPartNames: false, drawMeasureNumbers: true, measureNumberInterval: 1, drawTimeSignatures: true,
        autoGenerateMultipleRestMeasuresFromRestMeasures: false,
        autoBeam: true, drawFingerings: true, followCursor: false, disableCursor: true, setWantedStemDirectionByXml: true,
        defaultColorMusic: themeColor('--score-ink', '#534a40'),
        defaultColorLabel: themeColor('--score-ink', '#534a40'),
        defaultColorRest: themeColor('--score-ink', '#534a40'),
        pageBackgroundColor: themeColor('--score-paper', '#fffdfa'),
        stretchLastSystemLine: true
      })
      score.EngravingRules.TabTimeSignatureRendered = true
      score.EngravingRules.RenderStringNumbersClassical = false
      score.EngravingRules.PercussionOneLineCutoff = 0
      await score.load(doc)
      if (disposed) return
      // OSMD 2.2 subtracts FretNumber from bend-alter when choosing its TAB label.
      // MusicXML defines bend-alter as semitones, not a target fret. Adapt only
      // the renderer model; the original, standards-compliant XML stays intact.
      let adaptedBends = false
      for (const instrument of score.Sheet.Instruments) for (const voice of instrument.Voices) for (const entry of voice.VoiceEntries) for (const note of entry.Notes) {
        const tab = note as typeof note & { BendArray?: { bendalter: number }[]; FretNumber: number }
        if (tab.BendArray?.length) { for (const bend of tab.BendArray) bend.bendalter += tab.FretNumber; adaptedBends = true }
      }
      if (adaptedBends) score.updateGraphic()
      render()
    })().catch(fail)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize?.disconnect()
      score?.clear()
      container.replaceChildren()
    }
  }, [xml, label, anchors, eventAttribute, theme])
  return <div className={`ws-musicxml-score ${className}`} ref={viewport} aria-label={label} aria-busy={!state.ready && !state.error}>
    {state.error ? <p className="ws-error" role="alert">{state.error}</p> : !state.ready && <p className="ws-muted" role="status">正在排版谱例…</p>}
    <div className="ws-musicxml-pages" ref={host} />
  </div>
})
