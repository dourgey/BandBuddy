import type { ScoreAnchor } from './musicxml.js'
import type { LessonInstrument } from './lesson-document.js'
import { TUNINGS } from './theory.js'

/** Authored textbooks often contain just staff notation, even with string/fret annotations. */
export function addTextbookTab(xml: string, instrument: LessonInstrument): string {
  if (['drums', 'piano', 'keyboard'].includes(instrument)) return xml
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if ([...doc.querySelectorAll('clef sign')].some(s => s.textContent === 'TAB') || !doc.querySelector('pitch')) return xml
  const tuning = TUNINGS.find(t => t.id === (instrument === 'ukulele' ? 'uke-high' : instrument === 'bass' ? 'bass' : 'guitar'))!
  const make = (name: string, value: string): Element => { const node = doc.createElement(name); node.textContent = value; return node }
  const set = (node: Element, name: string, value: string): void => { const existing = node.querySelector(name); if (existing) existing.textContent = value; else node.append(make(name, value)) }
  const transpose = Number(doc.querySelector('transpose chromatic')?.textContent || 0) + 12 * Number(doc.querySelector('transpose octave-change')?.textContent || 0)
  for (const part of doc.querySelectorAll('part')) {
    for (const [index, measure] of [...part.querySelectorAll('measure')].entries()) {
      const source = [...measure.children].filter(n => ['note', 'backup', 'forward'].includes(n.tagName))
      let cursor = 0
      const copy = source.map(node => {
        const duration = Number(node.querySelector('duration')?.textContent || 0)
        if (node.tagName === 'backup') cursor -= duration
        else if (!node.querySelector('chord')) cursor += duration
        const clone = node.cloneNode(true) as Element
        if (node.tagName === 'note') {
          set(node, 'staff', '1'); set(clone, 'staff', '2')
          set(clone, 'voice', String(Number(node.querySelector('voice')?.textContent || 1) + 10))
        }
        return clone
      })
      // Assign a distinct string to every simultaneous chord note, preferring low positions.
      const groups: Element[][] = []
      for (const node of copy) if (node.tagName === 'note' && node.querySelector('pitch')) {
        if (!node.querySelector('chord') || !groups.length) groups.push([])
        groups[groups.length - 1]!.push(node)
      }
      for (const group of groups) {
        const candidates = group.map(note => {
          const technical = note.querySelector('technical')
          if (technical?.querySelector('string') && technical.querySelector('fret')) return [{ string: Number(technical.querySelector('string')!.textContent), fret: Number(technical.querySelector('fret')!.textContent) }]
          const pitch = note.querySelector('pitch')!
          const midi = (Number(pitch.querySelector('octave')!.textContent) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[pitch.querySelector('step')!.textContent as 'C']) + Number(pitch.querySelector('alter')?.textContent || 0) + transpose
          return tuning.notes.flatMap((open, i) => midi >= open && midi - open <= tuning.frets ? [{ string: tuning.notes.length - i, fret: midi - open }] : []).sort((a, b) => a.fret - b.fret)
        })
        type Position = { string: number; fret: number }
        let best: Position[] | undefined, bestCost = Infinity
        const search = (chosen: Position[]): void => {
          if (chosen.length === group.length) {
            const frets = chosen.map(p => p.fret).filter(f => f > 0)
            const cost = chosen.reduce((sum, p) => sum + p.fret, 0) + (frets.length ? Math.max(...frets) - Math.min(...frets) : 0) * 8
            if (cost < bestCost) { bestCost = cost; best = chosen }
            return
          }
          for (const position of candidates[chosen.length]!) if (!chosen.some(p => p.string === position.string)) search([...chosen, position])
        }
        search([])
        if (!best) throw new Error('教材音高超出当前乐器的可用弦品范围，无法生成准确 TAB')
        group.forEach((note, i) => {
          let notations = note.querySelector('notations'); if (!notations) { notations = doc.createElement('notations'); note.append(notations) }
          let technical = notations.querySelector('technical'); if (!technical) { technical = doc.createElement('technical'); notations.append(technical) }
          set(technical, 'string', String(best![i]!.string)); set(technical, 'fret', String(best![i]!.fret))
        })
      }
      let attributes = measure.querySelector('attributes')
      if (index === 0) {
        if (!attributes) { attributes = doc.createElement('attributes'); measure.prepend(attributes) }
        set(attributes, 'staves', '2')
        attributes.querySelector('clef')?.setAttribute('number', '1')
        const clef = doc.createElement('clef'); clef.setAttribute('number', '2'); clef.append(make('sign', 'TAB')); attributes.append(clef)
        const details = doc.createElement('staff-details'); details.setAttribute('number', '2'); details.append(make('staff-lines', String(tuning.notes.length))); attributes.append(details)
      }
      const backup = doc.createElement('backup'); backup.append(make('duration', String(cursor)))
      measure.append(backup, ...copy)
    }
  }
  return new XMLSerializer().serializeToString(doc)
}

/** Reorder staves without changing voices or MusicXML cursor movements. */
export function tabFirst(xml: string, showStaff: boolean, anchors?: ScoreAnchor[]): { xml: string; anchors?: ScoreAnchor[]; hasTab: boolean } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const clef = [...doc.querySelectorAll('clef')].find(c => c.querySelector('sign')?.textContent === 'TAB')
  if (!clef) return { xml, anchors, hasTab: false }
  const tab = Number(clef.getAttribute('number') || 1)
  const count = Number(doc.querySelector('staves')?.textContent || 1)
  const order = [tab, ...Array.from({ length: count }, (_, i) => i + 1).filter(n => n !== tab)]
  const map = (staff: number): number => order.indexOf(staff) + 1
  for (const note of doc.querySelectorAll('note')) {
    const staff = Number(note.querySelector('staff')?.textContent || 1)
    if (!showStaff && staff !== tab) {
      // Preserve cursor advance, including backups, without retaining hidden notes.
      if (note.querySelector('chord, grace') || !note.querySelector('duration')) note.remove()
      else { const forward = doc.createElement('forward'); forward.append(note.querySelector('duration')!.cloneNode(true)); note.replaceWith(forward) }
    }
  }
  for (const direction of doc.querySelectorAll('direction')) {
    const staff = direction.querySelector('staff')
    if (!showStaff && staff && Number(staff.textContent) !== tab) direction.remove()
  }
  for (const element of doc.querySelectorAll('clef, staff-details, key[number], time[number]')) {
    const staff = Number(element.getAttribute('number') || 1)
    if (!showStaff && staff !== tab) element.remove()
    else element.setAttribute('number', String(map(staff)))
  }
  for (const element of doc.querySelectorAll('staff')) element.textContent = String(map(Number(element.textContent)))
  for (const element of doc.querySelectorAll('staves')) element.textContent = String(showStaff ? count : 1)
  // TAB is readable on its own: print exact quarter-note durations below its notes.
  let divisions = 1
  for (const measure of doc.querySelectorAll('part > measure')) {
    divisions = Number(measure.querySelector('divisions')?.textContent || divisions)
    for (const note of measure.querySelectorAll('note')) {
      if (Number(note.querySelector('staff')?.textContent || 1) !== 1 || note.querySelector('chord, grace, lyric')) continue
      const duration = Number(note.querySelector('duration')?.textContent || 0) / divisions
      const denominator = [3, 6, 12].find(d => Math.abs(duration * d - Math.round(duration * d)) < 1e-8 && !Number.isInteger(duration * 4))
      const length = denominator ? `${Math.round(duration * denominator)}/${denominator}` : String(Number(duration.toFixed(3)))
      const text = doc.createElement('text'); text.textContent = `${note.querySelector('rest') ? '休' : ''}${length}`
      const lyric = doc.createElement('lyric'); lyric.append(text); note.append(lyric)
    }
  }
  return { xml: new XMLSerializer().serializeToString(doc), hasTab: true,
    anchors: anchors?.filter(a => showStaff || a.staff === tab).map(a => ({ ...a, staff: map(a.staff) })) }
}
