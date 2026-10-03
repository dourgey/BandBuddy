import { DOMParser, type Element } from '@xmldom/xmldom'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exerciseToMusicXml, ensembleToMusicXml, MUSICXML_DIVISIONS } from '../src/renderer/src/woodshed/musicxml.js'
import { TUNINGS } from '../src/renderer/src/woodshed/theory.js'
import { PRACTICE_EXERCISES, practiceTuning } from '../src/renderer/src/woodshed/practice-curriculum.js'
import { ENSEMBLE_EXERCISES } from '../src/renderer/src/woodshed/ensemble-curriculum.js'
import { generateExercise } from '../src/renderer/src/woodshed/generator.js'
import { DEFAULT_EXERCISE, type MusicEvent } from '../src/renderer/src/woodshed/types.js'
import { measureBeats, type EnsembleScore } from '../src/renderer/src/woodshed/ensemble-material.js'
import { validateMusicXml } from '../scripts/verify-learning-musicxml.mjs'

function parse(xml: string) { return new DOMParser({ onError: severity => { throw new Error(severity) } }).parseFromString(xml, 'application/xml') }
const elements = (element: Element, name: string): Element[] => Array.from(element.getElementsByTagName(name))
const value = (element: Element, name: string): string => elements(element, name)[0]?.textContent ?? ''
function inspect(xml: string) {
  const doc = parse(xml)
  const notes: { beat: number; duration: number; staff: number; voice: number; midi?: number; rest: boolean; instrument: string }[] = []
  let barStart = 0
  let division = 0
  for (const measure of elements(doc.documentElement!, 'measure')) {
    division = Number(value(measure, 'divisions')) || division
    let cursor = 0, maximum = 0, chordStart = 0
    for (const child of Array.from(measure.childNodes).filter((n): n is Element => n.nodeType === 1)) {
      const duration = Number(value(child, 'duration')) / division
      if (child.tagName === 'backup') cursor -= duration
      else if (child.tagName === 'forward') cursor += duration
      else if (child.tagName === 'note') {
        const chord = elements(child, 'chord').length > 0
        if (!chord) chordStart = cursor
        const p = elements(child, 'pitch')[0]
        const pitch = p ? (Number(value(p, 'octave')) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[value(p, 'step') as 'C'] + Number(value(p, 'alter')) : undefined
        notes.push({ beat: barStart + chordStart, duration, staff: Number(value(child, 'staff')), voice: Number(value(child, 'voice')), midi: pitch, rest: elements(child, 'rest').length > 0, instrument: elements(child, 'instrument')[0]?.getAttribute('id') ?? '' })
        if (!chord) cursor += duration
        maximum = Math.max(cursor, maximum)
      }
      expect(cursor).toBeGreaterThanOrEqual(-1e-8)
    }
    barStart += maximum
  }
  return { doc, notes, beats: barStart }
}

describe('Woodshed MusicXML conversion', () => {
  it('exports every authored string exercise without changing time, pitch, string or fret', () => {
    for (const exercise of PRACTICE_EXERCISES) for (const variant of exercise.variants) {
      const result = exerciseToMusicXml(variant.events, practiceTuning(exercise.instrument), { meter: variant.meter, pattern: 'scale' })
      const parsed = inspect(result.xml)
      expect(parsed.beats, exercise.id).toBeCloseTo(variant.beats, 7)
      const played = parsed.notes.filter(n => !n.rest && n.staff === 1)
      const ticks = (n: number) => Math.round(n * MUSICXML_DIVISIONS)
      expect(played.map(n => [ticks(n.beat), ticks(n.duration), n.midi]), exercise.id).toEqual(variant.events.flatMap(e => e.notes.map(n => [ticks(e.beat), ticks(e.duration), n.midi])))
      const tabNotes = elements(parsed.doc.documentElement!, 'note').filter(n => value(n, 'staff') === '2')
      expect(tabNotes.flatMap(n => elements(n, 'string')).map(n => Number(n.textContent))).toEqual(variant.events.flatMap(e => e.notes.map(n => n.string)))
      expect(tabNotes.flatMap(n => elements(n, 'fret')).map(n => Number(n.textContent))).toEqual(variant.events.flatMap(e => e.notes.map(n => n.fret)))
      expect(new Set(result.anchors.map(a => a.id))).toEqual(new Set(variant.events.map(e => e.id)))
    }
  })
  it('preserves triplets, dotted compound-meter values, ties and alternate tunings', () => {
    for (const tuning of TUNINGS) for (const meter of ['4/4', '6/8', '7/8', '12/8']) for (const subdivision of [1, 2, 3, 4]) {
      const config = { ...DEFAULT_EXERCISE, meter, subdivision }
      const generated = generateExercise(tuning, 0, config)
      const result = exerciseToMusicXml(generated.events, tuning, config)
      const parsed = inspect(result.xml)
      expect(parsed.beats).toBeCloseTo(generated.beats, 7)
      expect(Number(value(parsed.doc.documentElement!, 'staff-lines'))).toBe(tuning.notes.length)
      expect(elements(parsed.doc.documentElement!, 'staff-tuning')).toHaveLength(tuning.notes.length)
      for (const event of generated.events) {
        const notes = parsed.notes.filter(n => Math.abs(n.beat - event.beat) < 1e-7)
        expect(notes).not.toHaveLength(0)
        expect(notes[0]!.duration).toBeCloseTo(event.duration)
      }
      if (meter === '4/4' && subdivision === 3) expect(elements(parsed.doc.documentElement!, 'time-modification').length).toBeGreaterThan(0)
      if (meter === '6/8' && subdivision === 2) {
        expect(elements(parsed.doc.documentElement!, 'dot').length).toBeGreaterThan(0)
        expect(elements(parsed.doc.documentElement!, 'time-modification')).toHaveLength(0)
      }
    }
  })
  it('writes connected guitar techniques, explicit rests and matching cross-bar ties', () => {
    const note = { midi: 64, string: 1, fret: 0 }
    const events: MusicEvent[] = [
      { id: 'a', beat: 0, duration: 1, notes: [note], technique: 'hammer' },
      { id: 'b', beat: 1, duration: 1, notes: [{ ...note, midi: 66, fret: 2 }], technique: 'slide' },
      { id: 'c', beat: 2, duration: 1, notes: [{ ...note, midi: 67, fret: 3 }], bend: 2 },
      { id: 'd', beat: 3, duration: 2, notes: [note] },
      { id: 'e', beat: 5, duration: 1, notes: [note], tie: true },
      { id: 'f', beat: 6, duration: 2, notes: [] }
    ]
    const result = exerciseToMusicXml(events, TUNINGS[0]!, DEFAULT_EXERCISE)
    const { doc, notes, beats } = inspect(result.xml)
    expect(beats).toBe(8)
    expect(elements(doc.documentElement!, 'hammer-on').map(n => n.getAttribute('type'))).toEqual(['start', 'stop', 'start', 'stop'])
    expect(elements(doc.documentElement!, 'slide').map(n => n.getAttribute('type'))).toEqual(['start', 'stop', 'start', 'stop'])
    expect(value(doc.documentElement!, 'bend-alter')).toBe('2')
    expect(elements(doc.documentElement!, 'tied')).toHaveLength(8)
    expect(notes.filter(n => n.rest && n.staff === 1)).toEqual([expect.objectContaining({ beat: 6, duration: 2 })])
  })
  it('records capo position while retaining sounding pitches and relative fret numbers', () => {
    const generated = generateExercise(TUNINGS[0]!, 2, DEFAULT_EXERCISE)
    const parsed = inspect(exerciseToMusicXml(generated.events, TUNINGS[0]!, DEFAULT_EXERCISE).xml)
    expect(value(parsed.doc.documentElement!, 'capo')).toBe('2')
    expect(parsed.notes.filter(n => n.staff === 1 && !n.rest).map(n => n.midi)).toEqual(generated.events.flatMap(e => e.notes.map(n => n.midi)))
  })
  it('exports every ensemble score with complete independent hand/foot timelines and event anchors', () => {
    for (const exercise of ENSEMBLE_EXERCISES) for (const score of exercise.variants) {
      const drums = score.events.some(e => !!e.drum)
      const result = ensembleToMusicXml(score, drums)
      const parsed = inspect(result.xml)
      expect(parsed.beats, exercise.id).toBeCloseTo(score.bars * measureBeats(score.meter), 7)
      expect(new Set(result.anchors.map(a => a.id)), exercise.id).toEqual(new Set(score.events.map(e => e.id)))
      for (const event of score.events) {
        const notes = parsed.notes.filter(n => !n.rest && Math.abs(n.beat - event.beat) < 1e-7 && (event.drum ? n.instrument === `P1-${event.drum}` : n.staff === (event.hand === 'L' ? 2 : 1)))
        expect(notes, `${exercise.id} ${event.id}`).toHaveLength(event.drum ? 1 : event.notes.length)
        if (!event.drum) expect(notes.map(n => n.midi)).toEqual(event.notes)
        expect(notes[0]?.duration ?? event.duration).toBeCloseTo(event.duration)
      }
      if (drums) {
        expect(elements(parsed.doc.documentElement!, 'unpitched').length).toBe(score.events.length)
        expect(value(parsed.doc.documentElement!, 'staff-lines')).toBe('5')
        expect(value(parsed.doc.documentElement!, 'sign')).toBe('percussion')
      }
      else expect(value(parsed.doc.documentElement!, 'staves')).toBe('2')
    }
  })
  it('uses legal empty scores and escapes XML text', () => {
    const score: EnsembleScore = { name: 'C & D <example>', description: '', meter: '4/4', beatUnit: 1, bars: 1, events: [] }
    const parsed = inspect(ensembleToMusicXml(score, false).xml)
    expect(value(parsed.doc.documentElement!, 'work-title')).toBe(score.name)
    expect(parsed.beats).toBe(4)
    expect(parsed.notes.every(n => n.rest)).toBe(true)
    expect(value(parsed.doc.documentElement!, 'divisions')).toBe(String(MUSICXML_DIVISIONS))
    expect(inspect(exerciseToMusicXml([], TUNINGS[0]!, DEFAULT_EXERCISE).xml).beats).toBe(4)
  })

  it('keeps every authored MusicXML file rhythmically complete with valid ties and instrument references', () => {
    const directory = resolve('resources/learning/scores')
    const files = readdirSync(directory).filter(file => file.endsWith('.musicxml'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(validateMusicXml(readFileSync(resolve(directory, file), 'utf8'), file).errors).toEqual([])
  })

  it('matches high-G chord shapes, walking-bass approach spelling, and instrument ranges', () => {
    const read = (id: string) => inspect(readFileSync(resolve(`resources/learning/scores/${id}.musicxml`), 'utf8'))
    const ukulele = read('ukulele-5')
    // G4 C4 E4 A4 + each shape in string order, sorted into staff order.
    for (const [bar, shape] of [[0, [0, 0, 0, 3]], [1, [2, 0, 0, 0]], [2, [2, 0, 1, 0]], [3, [0, 2, 3, 2]]] as const) {
      expect(ukulele.notes.filter(n => n.beat === bar * 4).map(n => n.midi).sort((a, b) => a! - b!)).toEqual([67, 60, 64, 69].map((midi, i) => midi + shape[i]!).sort((a, b) => a - b))
    }
    const bass = read('bass-15')
    expect(bass.notes.map(n => n.midi)).toEqual([36, 40, 43, 42, 41, 45, 36, 35])
    const approaching = elements(bass.doc.documentElement!, 'note')[3]!
    expect(value(approaching, 'step')).toBe('G')
    expect(value(approaching, 'alter')).toBe('-1')
    for (const id of ['blues-2', 'blues-4', 'blues-5', 'blues-10']) {
      const ukuleleNotes = read(`${id}-ukulele`).notes.flatMap(n => n.midi === undefined ? [] : [n.midi])
      const bassNotes = read(`${id}-bass`).notes.flatMap(n => n.midi === undefined ? [] : [n.midi])
      expect(Math.min(...ukuleleNotes)).toBeGreaterThanOrEqual(60)
      expect(Math.max(...ukuleleNotes)).toBeLessThanOrEqual(87)
      expect(Math.min(...bassNotes)).toBeGreaterThanOrEqual(28)
      expect(Math.max(...bassNotes)).toBeLessThanOrEqual(67)
    }
  })
})
