import type { ExerciseConfig, MusicEvent, Technique } from './types.js'
import type { Tuning } from './theory.js'
import { DRUM_LABELS, measureBeats, type DrumVoice, type EnsembleScore } from './ensemble-material.js'

/** Quarter-note ticks: exact for binary subdivisions, dotted notes and triplets. */
export const MUSICXML_DIVISIONS = 480
export interface ScoreAnchor {
  id: string
  beat: number
  voice: number
  staff: number
  label: string
  instrument?: string
}
export interface MusicXmlDocument { xml: string; anchors: ScoreAnchor[] }
const esc = (value: string | number): string => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
const tick = (beats: number): number => Math.round(beats * MUSICXML_DIVISIONS)
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

interface NoteInput {
  midi?: number
  string?: number
  fret?: number
  drum?: DrumVoice
  id: string
  label: string
  velocity?: number
}
interface EventInput {
  id: string
  beat: number
  duration: number
  notes: NoteInput[]
  label: string
  technique?: Technique
  bend?: number
  tie?: boolean
}
interface WrittenDuration { ticks: number; type: string; dotted?: boolean; triplet?: boolean }
const values: WrittenDuration[] = [
  [4, 'whole'], [3, 'half', true], [2, 'half'], [1.5, 'quarter', true], [1, 'quarter'],
  [.75, 'eighth', true], [.5, 'eighth'], [.375, '16th', true], [.25, '16th'],
  [.1875, '32nd', true], [.125, '32nd'], [.0625, '64th']
].map(([beats, type, dotted]) => ({ ticks: tick(Number(beats)), type: String(type), dotted: !!dotted }))
const tripletValues: WrittenDuration[] = [[2 / 3, 'quarter'], [1 / 3, 'eighth'], [1 / 6, '16th'], [1 / 12, '32nd']]
  .map(([beats, type]) => ({ ticks: tick(Number(beats)), type: String(type), triplet: true }))
function durations(ticks: number): WrittenDuration[] {
  const exact = [...values, ...tripletValues].find(v => v.ticks === ticks)
  if (exact) return [exact]
  const result: WrittenDuration[] = []
  while (ticks > 0) {
    const value = [...values, ...tripletValues].sort((a, b) => b.ticks - a.ticks).find(v => v.ticks <= ticks)
    if (!value) throw new Error('谱例包含不能准确记写的时值')
    result.push(value)
    ticks -= value.ticks
  }
  return result
}
function pitch(midi: number, prefix = ''): string {
  const names = ['C', 'C', 'D', 'E', 'E', 'F', 'F', 'G', 'A', 'A', 'B', 'B']
  const alterations = [0, 1, 0, -1, 0, 0, 1, 0, -1, 0, -1, 0]
  const pc = ((midi % 12) + 12) % 12
  return `<${prefix}step>${names[pc]}</${prefix}step>${alterations[pc] ? `<${prefix}alter>${alterations[pc]}</${prefix}alter>` : ''}<${prefix}octave>${Math.floor(midi / 12) - 1}</${prefix}octave>`
}
const drumNotation: Record<DrumVoice, { step: string; octave: number; midi: number; cross?: boolean }> = {
  kick: { step: 'F', octave: 4, midi: 36 }, snare: { step: 'C', octave: 5, midi: 38 },
  hat: { step: 'G', octave: 5, midi: 42, cross: true }, openHat: { step: 'G', octave: 5, midi: 46, cross: true },
  pedal: { step: 'D', octave: 4, midi: 44, cross: true }, tom: { step: 'E', octave: 5, midi: 48 },
  crash: { step: 'A', octave: 5, midi: 49, cross: true }, ride: { step: 'F', octave: 5, midi: 51, cross: true }
}
const drumId = (drum: DrumVoice): string => `P1-${drum}`
interface Slice { event?: EventInput; beat: number; value: WrittenDuration; starts: boolean; ends: boolean; tupletStart?: boolean; tupletStop?: boolean }

/** Fill gaps and split sustained values at barlines without changing their sounding length. */
function timeline(events: EventInput[], start: number, end: number): Slice[] {
  const slices: Slice[] = []
  let cursor = tick(start)
  const endTick = tick(end)
  function append(from: number, to: number, event?: EventInput): void {
    let position = from
    for (const value of durations(to - from)) {
      slices.push({ event, beat: position / MUSICXML_DIVISIONS, value,
        starts: !event || position === tick(event.beat), ends: !event || position + value.ticks === tick(event.beat + event.duration) })
      position += value.ticks
    }
  }
  for (const event of events) {
    const from = Math.max(tick(start), tick(event.beat)), to = Math.min(endTick, tick(event.beat + event.duration))
    if (to <= from) continue
    if (from < cursor) throw new Error('同一声部包含重叠音符')
    if (from > cursor) append(cursor, from)
    append(from, to, event)
    cursor = to
  }
  if (cursor < endTick) append(cursor, endTick)
  for (let i = 0; i < slices.length; i++) {
    const first = slices[i]!
    if (!first.value.triplet) continue
    let last = i
    if (slices.slice(i, i + 3).length === 3 && slices.slice(i, i + 3).every(s => s.value.triplet && s.value.ticks === first.value.ticks)) last = i + 2
    else {
      let sum = first.value.ticks
      while (sum % MUSICXML_DIVISIONS !== 0 && slices[last + 1]?.value.triplet) sum += slices[++last]!.value.ticks
    }
    first.tupletStart = true
    slices[last]!.tupletStop = true
    i = last
  }
  return slices
}
function sameNote(a: NoteInput, b: NoteInput): boolean { return a.midi === b.midi && a.string === b.string && a.drum === b.drum }
function connection(technique: Technique | undefined, type: 'start' | 'stop'): string {
  if (technique === 'hammer' || technique === 'pull') return `<${technique === 'hammer' ? 'hammer-on' : 'pull-off'} type="${type}" number="1">${type === 'start' ? technique === 'hammer' ? 'H' : 'P' : ''}</${technique === 'hammer' ? 'hammer-on' : 'pull-off'}>`
  return ''
}
function renderVoice(events: EventInput[], start: number, end: number, voice: number, staff: number, anchors: ScoreAnchor[], rhythm = false): string {
  const slices = timeline(events, start, end)
  return slices.map((slice, index) => {
    const event = slice.event, notes = event?.notes ?? [], rest = notes.length === 0
    const eventIndex = event ? events.indexOf(event) : -1
    const previous = events[eventIndex - 1], next = events[eventIndex + 1]
    const previousConnected = !!previous && !!event && close(previous.beat + previous.duration, event.beat)
    const nextConnected = !!next && !!event && close(event.beat + event.duration, next.beat)
    const direction = event?.technique === 'vibrato' && slice.starts ? `<direction placement="above"><direction-type><words>vibrato</words></direction-type><voice>${voice}</voice><staff>${staff}</staff></direction>` : ''
    const rendered = (rest ? [undefined] : notes).map((note, chordIndex) => {
      const continuation = !!note && !note.drum && !slice.starts
      const outgoing = !!note && !note.drum && !slice.ends
      const tieStop = continuation || !!(note && event?.tie && previousConnected && previous?.notes.some(p => sameNote(p, note)))
      const tieStart = outgoing || !!(note && next?.tie && nextConnected && next.notes.some(p => sameNote(p, note)))
      let technical = ''
      if (note?.string) technical += `<string>${note.string}</string><fret>${note.fret}</fret>`
      if (note && chordIndex === 0) {
        if (slice.starts && previousConnected) technical += connection(previous?.technique, 'stop')
        if (slice.ends && nextConnected && next?.notes.length) technical += connection(event?.technique, 'start')
        if (slice.starts && event?.bend) technical += `<bend><bend-alter>${event.bend}</bend-alter></bend>`
        if (slice.starts && (event?.technique === 'down' || event?.technique === 'up')) technical += `<${event.technique === 'down' ? 'down-bow' : 'up-bow'}/>`
      }
      let notation = `${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}`
      if (note && chordIndex === 0 && slice.starts && previousConnected && previous?.technique === 'slide') notation += '<slide type="stop" number="1"/>'
      if (note && chordIndex === 0 && slice.ends && nextConnected && next?.notes.length && event?.technique === 'slide') notation += '<slide type="start" number="1" line-type="solid"/>'
      if (technical) notation += `<technical>${technical}</technical>`
      if (chordIndex === 0) {
        if (slice.tupletStart) notation += '<tuplet type="start" number="1" bracket="yes"/>'
        if (slice.tupletStop) notation += '<tuplet type="stop" number="1"/>'
      }
      if (note?.drum && note.velocity !== undefined && note.velocity >= .7) notation += '<articulations><accent/></articulations>'
      if (note?.drum === 'openHat') notation += '<technical><open-string/></technical>'
      if (note) anchors.push({ id: note.id, beat: slice.beat, voice, staff, label: note.label, instrument: note.drum ? drumId(note.drum) : undefined })
      else if (event) anchors.push({ id: event.id, beat: slice.beat, voice, staff, label: event.label })
      const unpitched = note?.drum ? drumNotation[note.drum] : { step: 'C', octave: 5 }
      const tone = !note ? '<rest/>' : rhythm || note.drum ? `<unpitched><display-step>${unpitched.step}</display-step><display-octave>${unpitched.octave}</display-octave></unpitched>` : `<pitch>${pitch(note.midi!)}</pitch>`
      const drumCross = note?.drum && drumNotation[note.drum].cross
      const head = note && (drumCross || event?.technique === 'mute') ? `<notehead${note.velocity !== undefined && note.velocity < .4 ? ' parentheses="yes"' : ''}>x</notehead>` : note?.drum && note.velocity !== undefined && note.velocity < .4 ? '<notehead parentheses="yes">normal</notehead>' : rhythm && note ? '<notehead>slash</notehead>' : ''
      return `<note id="bb-${voice}-${tick(slice.beat)}-${index}-${chordIndex}">${chordIndex ? '<chord/>' : ''}${tone}<duration>${slice.value.ticks}</duration>${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}${note?.drum ? `<instrument id="${drumId(note.drum)}"/>` : ''}<voice>${voice}</voice><type>${slice.value.type}</type>${slice.value.dotted ? '<dot/>' : ''}${slice.value.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : ''}${note?.drum ? `<stem>${voice === 2 ? 'down' : 'up'}</stem>` : ''}${head}<staff>${staff}</staff>${notation ? `<notations>${notation}</notations>` : ''}${note?.drum && note.label ? `<lyric><text>${esc(note.label)}</text></lyric>` : ''}</note>`
    }).join('')
    return direction + rendered
  }).join('')
}
function documentXml(name: string, partName: string, measures: string[], drums: DrumVoice[] = []): string {
  const instruments = drums.map(d => `<score-instrument id="${drumId(d)}"><instrument-name>${DRUM_LABELS[d]}</instrument-name></score-instrument>`).join('')
    + drums.map(d => `<midi-instrument id="${drumId(d)}"><midi-channel>10</midi-channel><midi-unpitched>${drumNotation[d].midi + 1}</midi-unpitched></midi-instrument>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?><score-partwise version="4.0"><work><work-title>${esc(name)}</work-title></work><part-list><score-part id="P1"><part-name>${esc(partName)}</part-name>${instruments}</score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`
}
const time = (meter: string): string => { const [n, d] = meter.split('/'); return `<time><beats>${n}</beats><beat-type>${d}</beat-type></time>` }

/** Source pitches are sounding pitches; the XML carries exact string/fret and tuning metadata. */
export function exerciseToMusicXml(events: MusicEvent[], tuning: Tuning, config: Pick<ExerciseConfig, 'meter' | 'pattern'>): MusicXmlDocument {
  const length = measureBeats(config.meter), anchors: ScoreAnchor[] = [], rhythm = config.pattern === 'rhythm'
  const source: EventInput[] = [...events].sort((a, b) => a.beat - b.beat).map(e => ({ ...e,
    label: `第 ${Math.floor(e.beat / length) + 1} 小节，${e.notes.length ? e.notes.map(n => `${n.string} 弦 ${n.fret} 品`).join('，') : '休止'}`,
    notes: e.notes.map(n => ({ ...n, id: e.id, label: `第 ${Math.floor(e.beat / length) + 1} 小节，${n.string} 弦 ${n.fret} 品` })) }))
  const bars = Math.max(1, Math.ceil((Math.max(0, ...events.map(e => e.beat + e.duration)) - 1e-6) / length))
  const strings = tuning.notes.map((midi, i) => `<staff-tuning line="${i + 1}">${pitch(midi, 'tuning-')}</staff-tuning>`).join('')
  const positioned = events.flatMap(e => e.notes)[0]
  const capo = positioned ? Math.max(0, positioned.midi - positioned.fret - tuning.notes[tuning.notes.length - positioned.string]!) : 0
  const clef = tuning.instrument === 'bass' ? '<sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change>' : `<sign>G</sign><line>2</line>${tuning.instrument === 'guitar' ? '<clef-octave-change>-1</clef-octave-change>' : ''}`
  // OSMD's TAB renderer omits duration stems. A synchronized standard staff
  // makes the written rhythm explicit, including long notes, dots and rests.
  const attributes = `<attributes><divisions>${MUSICXML_DIVISIONS}</divisions>${time(config.meter)}${rhythm ? '<clef><sign>percussion</sign></clef><staff-details><staff-lines>1</staff-lines></staff-details>' : `<staves>2</staves><clef number="1">${clef}</clef><clef number="2"><sign>TAB</sign></clef><staff-details number="2"><staff-lines>${tuning.notes.length}</staff-lines>${strings}${capo ? `<capo>${capo}</capo>` : ''}</staff-details>`}</attributes>`
  const measures = Array.from({ length: bars }, (_, bar) => `<measure number="${bar + 1}">${bar === 0 ? attributes : ''}${renderVoice(source, bar * length, (bar + 1) * length, 1, 1, anchors, rhythm)}${rhythm ? '' : `<backup><duration>${tick(length)}</duration></backup>${renderVoice(source, bar * length, (bar + 1) * length, 2, 2, anchors)}`}</measure>`)
  return { xml: documentXml(rhythm ? '节奏练习' : tuning.name, rhythm ? '节奏' : tuning.name, measures), anchors }
}

/** Keyboard hands retain independent timelines; percussion uses separate hand/foot voices. */
export function ensembleToMusicXml(score: EnsembleScore, drums: boolean): MusicXmlDocument {
  const anchors: ScoreAnchor[] = [], length = measureBeats(score.meter)
  const voices: EventInput[][] = [[], []]
  for (const e of [...score.events].sort((a, b) => a.beat - b.beat)) {
    const v = drums ? e.drum === 'kick' || e.drum === 'pedal' ? 1 : 0 : e.hand === 'L' ? 1 : 0
    const noteLabel = drums ? e.label ?? '' : `${e.hand === 'L' ? '左手' : '右手'}，第 ${Math.floor(e.beat / length) + 1} 小节`
    const notes: NoteInput[] = e.drum ? [{ drum: e.drum, id: e.id, label: noteLabel, velocity: e.velocity }] : e.notes.map(midi => ({ midi, id: e.id, label: noteLabel }))
    const at = voices[v]!.find(n => close(n.beat, e.beat) && close(n.duration, e.duration))
    if (at) at.notes.push(...notes)
    else voices[v]!.push({ id: e.id, beat: e.beat, duration: e.duration, notes, label: noteLabel })
  }
  const attributes = `<attributes><divisions>${MUSICXML_DIVISIONS}</divisions>${time(score.meter)}${drums ? '<clef><sign>percussion</sign></clef>' : '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'}</attributes>`
  const drumVoices = [...new Set(score.events.map(e => e.drum).filter((d): d is DrumVoice => !!d))]
  const hasFeet = voices[1]!.length > 0
  const measures = Array.from({ length: Math.max(1, score.bars) }, (_, bar) => `<measure number="${bar + 1}">${bar === 0 ? attributes : ''}${renderVoice(voices[0]!, bar * length, (bar + 1) * length, 1, 1, anchors)}${!drums || hasFeet ? `<backup><duration>${tick(length)}</duration></backup>${renderVoice(voices[1]!, bar * length, (bar + 1) * length, 2, drums ? 1 : 2, anchors)}` : ''}</measure>`)
  return { xml: documentXml(score.name, drums ? '鼓组' : '钢琴', measures, drumVoices), anchors }
}
