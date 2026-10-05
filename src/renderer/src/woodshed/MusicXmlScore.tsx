import { useNotation, useNotationCapability } from './NotationBody.js'
import { addTextbookTab, tabFirst } from './notation-layout.js'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
  /** Practice scores show the current four-bar system and the next system. */
  rolling?: boolean
  currentBar?: number
}

export const MusicXmlScore = memo(function MusicXmlScore(props: MusicXmlScoreProps): React.JSX.Element {
  const notation = useNotation()
  const projected = useMemo(() => {
    try { return { ...(notation ? tabFirst(addTextbookTab(props.xml, notation.instrument), notation.showStaff, props.anchors) : { xml: props.xml, anchors: props.anchors, hasTab: false }), error: '' } }
    catch (error) { return { xml: props.xml, anchors: props.anchors, hasTab: false, error: error instanceof Error ? error.message : String(error) } }
  }, [props.xml, props.anchors, notation?.showStaff, notation?.instrument])
  const drums = notation?.instrument === 'drums'
  const keyboard = notation?.instrument === 'piano' || notation?.instrument === 'keyboard'
  const rhythm = !keyboard && !drums && /<staff-lines>\s*1\s*<\/staff-lines>/.test(props.xml)
  useNotationCapability(projected.hasTab || rhythm)
  if (projected.error) return <p className="ws-error" role="alert">{projected.error}</p>
  return <>
    {(!notation || notation.showStaff || drums || projected.hasTab || rhythm) ? <RenderedMusicXmlScore {...props} xml={projected.xml} anchors={projected.anchors} /> : <p className="ws-muted">五线谱已隐藏</p>}
    {projected.hasTab && <p className="ws-notation-key">TAB 在上 · 数字为品位 · 下方时值以四分音符为一拍</p>}
  </>
})

/** Shared MusicXML reader for both authored lessons and generated practice material. */
const RenderedMusicXmlScore = memo(function RenderedMusicXmlScore({ xml, label, className = '', anchors, eventAttribute = 'data-event', onSelect, rolling = false, currentBar = 1 }: MusicXmlScoreProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null)
  const follow = useRef<(bar: number, smooth: boolean) => void>(() => {})
  const bar = useRef(currentBar)
  bar.current = currentBar
  const callback = useRef(onSelect)
  callback.current = onSelect
  const theme = useResolvedTheme()
  const [state, setState] = useState<{ ready: boolean; error: string }>({ ready: false, error: '' })
  useEffect(() => {
    const container = host.current, wrapper = viewport.current
    if (!container || !wrapper) return
    let disposed = false, score: OpenSheetMusicDisplay | undefined, frame = 0, lastWidth = 0
    let displayedRow = -1
    const renderWidth = (): number => Math.max(rolling ? 800 : 340, Math.floor(wrapper!.clientWidth))
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
      const width = renderWidth()
      container!.style.width = `${width}px`
      try {
        const playing = new Set(Array.from(container!.querySelectorAll(`[${eventAttribute}].active, [${eventAttribute}].ensemble-active`), n => n.getAttribute(eventAttribute)))
        score.render()
        attachEvents()
        if (rolling) {
          // Endless page coordinates are in OSMD units (ten SVG pixels at zoom 1).
          // Cut in the gap between complete systems, including all TAB/piano staves.
          const systems = score.GraphicSheet.MusicPages.flatMap(page => page.MusicSystems)
          const tops = systems.map(system => Math.max(0, (system.PositionAndShape.AbsolutePosition.y + system.PositionAndShape.BorderTop) * 10 * score!.Zoom - 10))
          const bottom = systems.length ? (systems.at(-1)!.PositionAndShape.AbsolutePosition.y + systems.at(-1)!.PositionAndShape.BorderBottom) * 10 * score.Zoom + 12 : 0
          displayedRow = -1
          follow.current = (current, smooth) => {
            const row = Math.min(Math.max(0, Math.floor((current - 1) / 4)), Math.max(0, systems.length - 1))
            if (row === displayedRow || !systems.length) return
            const top = row === 0 ? 0 : tops[row]!
            const end = tops[row + 2] ?? bottom
            const height = Math.ceil(end - top)
            wrapper!.style.height = `${height}px`
            wrapper!.scrollTo({ top, behavior: smooth && row > displayedRow && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
            wrapper!.setAttribute('data-score-row', String(row))
            wrapper!.setAttribute('data-score-systems', String(systems.length))
            displayedRow = row
          }
          follow.current(bar.current, false)
        }
        for (const note of container!.querySelectorAll(`[${eventAttribute}]`)) if (playing.has(note.getAttribute(eventAttribute))) note.classList.add(eventAttribute === 'data-event' ? 'active' : 'ensemble-active')
        lastWidth = width
        wrapper!.setAttribute('data-rendered-score', label)
        setState({ ready: true, error: '' })
      } catch (error) { fail(error) }
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (Math.abs(renderWidth() - lastWidth) < 2) return
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
        backend: 'svg', autoResize: false, drawingParameters: rolling ? 'default' : 'compacttight',
        pageFormat: 'Endless',
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
      score.EngravingRules.LyricsHeight = 1.1
      score.EngravingRules.DefaultColorLyrics = themeColor('--score-ink', '#534a40')
      score.EngravingRules.RenderStringNumbersClassical = false
      score.EngravingRules.PercussionOneLineCutoff = 0
      if (rolling) {
        score.EngravingRules.RenderXMeasuresPerLineAkaSystem = 4
        score.EngravingRules.NewSystemAtXMLNewSystemAttribute = false
        score.EngravingRules.NewSystemAtXMLNewPageAttribute = false
        score.EngravingRules.NewPageAtXMLNewPageAttribute = false
      }
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
      follow.current = () => {}
      wrapper.style.height = ''
      score?.clear()
      container.replaceChildren()
    }
  }, [xml, label, anchors, eventAttribute, theme, rolling])
  useEffect(() => { follow.current(currentBar, true) }, [currentBar])
  return <div className={`ws-musicxml-score ${rolling ? 'ws-rolling-score' : ''} ${className}`} ref={viewport} aria-label={label} aria-busy={!state.ready && !state.error}>
    {state.error ? <p className="ws-error" role="alert">{state.error}</p> : !state.ready && <p className="ws-muted" role="status">正在排版谱例…</p>}
    <div className="ws-musicxml-pages" ref={host} />
  </div>
})
