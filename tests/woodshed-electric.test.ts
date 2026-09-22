import { describe, expect, it } from 'vitest'
import {
  GUITAR_PROJECTS,
  electricDefaults,
  guitarProjectExercise,
  projectConfig
} from '../src/renderer/src/woodshed/electric.js'
import { TUNINGS, mod } from '../src/renderer/src/woodshed/theory.js'
import { meterLength } from '../src/renderer/src/woodshed/generator.js'
import { DEFAULT_EXERCISE } from '../src/renderer/src/woodshed/types.js'
import { LESSONS } from '../src/renderer/src/woodshed/curriculum.js'
import { defaults, decodePreferences } from '../src/renderer/src/woodshed/preferences.js'
const guitar = TUNINGS[0]!
const project = (id: string) => GUITAR_PROJECTS.find((p) => p.id === id)!
const generate = (id: string, stage: number) =>
  guitarProjectExercise(project(id), guitar, 0, { stage, shift: 0 })
describe('original electric guitar project scores', () => {
  it('provides 36 musically distinct, complete and playable scores from a single event source', () => {
    expect(GUITAR_PROJECTS).toHaveLength(12)
    const scores = new Set<string>()
    for (const p of GUITAR_PROJECTS) {
      for (let stage = 0; stage < 3; stage++) {
        const result = guitarProjectExercise(p, guitar, 0, { stage, shift: 0 })
        let at = 0
        const length = meterLength(p.meter)
        const ids = new Set<string>()
        for (const e of result.events) {
          expect(e.beat, `${p.id}/${stage}`).toBe(at)
          expect(e.duration).toBeGreaterThan(0)
          expect((e.beat % length) + e.duration).toBeLessThanOrEqual(length)
          at += e.duration
          ids.add(e.id)
          expect(new Set(e.notes.map((n) => n.string)).size).toBe(e.notes.length)
          for (const n of e.notes) {
            expect(n.string).toBeGreaterThanOrEqual(1)
            expect(n.string).toBeLessThanOrEqual(6)
            expect(n.fret).toBeGreaterThanOrEqual(0)
            expect(n.fret).toBeLessThanOrEqual(guitar.frets)
            expect(n.midi).toBe(guitar.notes[6 - n.string]! + n.fret)
          }
        }
        expect(at).toBe(result.beats)
        expect(at).toBe(result.bars * length)
        expect(ids.size).toBe(result.events.length)
        scores.add(
          JSON.stringify(
            result.events.map(({ notes, duration, accent, technique, velocity, palmMute }) => ({
              notes,
              duration,
              accent,
              technique,
              velocity,
              palmMute
            }))
          )
        )
      }
    }
    expect(scores.size).toBe(36)
  })
  it('transposes every sounding pitch with fret offset and capo without altering rhythm or source data', () => {
    for (const p of GUITAR_PROJECTS) {
      const base = guitarProjectExercise(p, guitar, 0, { stage: 1, shift: 0 })
      const moved = guitarProjectExercise(p, guitar, 2, { stage: 1, shift: 3 })
      expect(moved.events.map((e) => [e.beat, e.duration])).toEqual(
        base.events.map((e) => [e.beat, e.duration])
      )
      moved.events.forEach((e, i) =>
        e.notes.forEach((n, j) => {
          expect(n.midi).toBe(base.events[i]!.notes[j]!.midi + 5)
          expect(n.fret).toBe(base.events[i]!.notes[j]!.fret + 3)
        })
      )
      expect(projectConfig(p, DEFAULT_EXERCISE, { stage: 1, shift: 3 }, 2).root).toBe(mod(p.root + 5))
    }
  })
  it('rejects incompatible tunings and impossible fingerings, while accepting a standard custom tuning', () => {
    const p = project('hard-riff')
    for (const tuning of TUNINGS.slice(1))
      expect(() => guitarProjectExercise(p, tuning, 0, electricDefaults())).toThrow('标准调弦')
    expect(() =>
      guitarProjectExercise(p, { ...guitar, id: 'guitar-custom' }, 0, electricDefaults())
    ).not.toThrow()
    expect(() => guitarProjectExercise(p, guitar, 0, { stage: 0, shift: -1 })).toThrow('可演奏品位')
    expect(() =>
      guitarProjectExercise(project('two-hand-puzzle'), guitar, 12, { stage: 2, shift: 7 })
    ).toThrow('可演奏品位')
  })
  it('encodes 7/8 separately from 3+3+2 accents within 4/4', () => {
    const seven = generate('math-grid', 0),
      eight = generate('accent-shift', 0)
    expect(seven.beats / seven.bars).toBe(3.5)
    expect(eight.beats / eight.bars).toBe(4)
    expect(
      seven.events
        .slice(0, 7)
        .filter((e) => e.accent)
        .map((e) => e.beat)
    ).toEqual([0, 1, 2])
    expect(
      eight.events
        .slice(0, 8)
        .filter((e) => e.accent)
        .map((e) => e.beat)
    ).toEqual([0, 1.5, 3])
  })
  it('keeps bends, legato and tapping attached to correct pitches and strings', () => {
    for (let stage = 0; stage < 3; stage++) {
      const bends = generate('bend-target', stage).events.filter((e) => e.bend)
      expect(bends.length).toBeGreaterThan(0)
      bends.forEach((e) => expect(e.notes[0]!.midi + e.bend!).toBe(69))
      for (const p of GUITAR_PROJECTS) {
        const events = guitarProjectExercise(p, guitar, 0, { stage, shift: 0 }).events
        events.forEach((e, i) => {
          if (e.technique !== 'hammer' && e.technique !== 'pull') return
          const next = events[i + 1]!
          expect(e.notes[0]!.string).toBe(next.notes[0]!.string)
          expect(
            e.technique === 'hammer'
              ? next.notes[0]!.fret > e.notes[0]!.fret
              : next.notes[0]!.fret < e.notes[0]!.fret
          ).toBe(true)
        })
      }
    }
    expect(
      generate('two-hand-puzzle', 2)
        .events.filter((e) => e.technique === 'tap')
        .map((e) => e.notes[0]!.midi)
    ).toEqual([76, 79])
  })
  it('preserves the common E and actual chord membership in the post-rock miniature', () => {
    const events = generate('post-layers', 1).events
    const tones = [
      [0, 4, 7],
      [9, 0, 4],
      [5, 9, 4],
      [7, 11, 4]
    ]
    for (let bar = 0; bar < 4; bar++) {
      const notes = events.filter((e) => Math.floor(e.beat / 4) === bar).flatMap((e) => e.notes)
      expect(notes.some((n) => n.string === 1 && n.midi === 64)).toBe(true)
      expect(new Set(notes.map((n) => mod(n.midi)))).toEqual(new Set(tones[bar]))
    }
  })
})
describe('electric style curriculum and persistence', () => {
  it('covers four style routes and eight fully described skill projects with valid playable links', () => {
    const lessons = LESSONS.filter((l) => l.track === 'electric')
    expect(lessons).toHaveLength(24)
    for (const category of ['硬摇', '朋克', '后摇', '数摇'])
      expect(lessons.filter((l) => l.category === category)).toHaveLength(4)
    expect(lessons.filter((l) => l.category === '机能项目')).toHaveLength(8)
    for (const l of lessons) {
      expect(l.explanation.length).toBeGreaterThan(80)
      expect(l.steps).toHaveLength(3)
      const p = project(l.guitarProjectId!)
      expect(p).toBeDefined()
      expect(() => guitarProjectExercise(p, guitar, 0, { stage: l.guitarStage!, shift: 0 })).not.toThrow()
    }
  })
  it('restores project version, offset, odd meter and favorites while preserving old workspaces', () => {
    const { electric, ...old } = defaults()
    old.piano.bpm = 86
    old.favorites = ['piano-1', 'electric-15']
    expect(decodePreferences(JSON.stringify(old))).toMatchObject({
      electric,
      piano: { bpm: 86 },
      favorites: old.favorites
    })
    const saved = {
      ...old,
      lessonId: 'electric-15',
      electric: { stage: 2, shift: 4 },
      exercise: { ...old.exercise, meter: '7/8' }
    }
    expect(decodePreferences(JSON.stringify(saved))).toMatchObject(saved)
    expect(
      decodePreferences(JSON.stringify({ ...saved, electric: { stage: 999, shift: -99 } }))
    ).toMatchObject({ electric: electricDefaults(), piano: { bpm: 86 }, lessonId: 'electric-15' })
  })
})
