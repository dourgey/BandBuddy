import { describe, expect, it } from 'vitest'
import {
  pianoDefaults,
  pianoExercise,
  pianoVoicing,
  keyboardLayout,
  PIANO_PATTERNS,
  pianoSpelling
} from '../src/renderer/src/woodshed/piano.js'
import { CHORDS, SCALES, parseNote, mod } from '../src/renderer/src/woodshed/theory.js'
import { LESSONS } from '../src/renderer/src/woodshed/curriculum.js'
import { COURSES, chapterFor } from '../src/renderer/src/woodshed/course-plan.js'
import { defaults, decodePreferences } from '../src/renderer/src/woodshed/preferences.js'
describe('piano pitches, voices and shared score events', () => {
  it('generates all keys, patterns and hand selections within piano range and complete bars', () => {
    for (let root = 0; root < 12; root++)
      for (const pattern of Object.keys(PIANO_PATTERNS) as (keyof typeof PIANO_PATTERNS)[])
        for (const hands of ['both', 'left', 'right'] as const) {
          const result = pianoExercise({ ...pianoDefaults(), root, pattern, hands })
          expect(result.beats % 4).toBe(0)
          let beat = 0
          result.events.forEach((e) => {
            expect(e.beat).toBe(beat)
            beat += e.duration
            expect(e.pitches).toEqual([...e.left, ...e.right])
            expect(e.names.map(parseNote)).toEqual(e.pitches)
            expect(e.pitches.every((n) => n >= 21 && n <= 108)).toBe(true)
            if (hands === 'left') expect(e.right).toEqual([])
            if (hands === 'right') expect(e.left).toEqual([])
          })
        }
  })
  it('plays the left hand down the same major scale in contrary motion, without chromatic inversion', () => {
    const result = pianoExercise({ ...pianoDefaults(), pattern: 'contrary' }).events.filter(
      (e) => e.pitches.length
    )
    expect(result.slice(0, 8).map((e) => e.left[0])).toEqual([60, 59, 57, 55, 53, 52, 50, 48])
    expect(result.slice(0, 8).map((e) => e.right[0])).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
  })
  it('spells all minor forms and enharmonic octave boundaries', () => {
    for (const scale of ['major', 'minor', 'harmonic'] as const)
      for (let root = 0; root < 12; root++) {
        const { events } = pianoExercise({ ...pianoDefaults(), root, scale, pattern: 'scale' })
        for (const e of events) {
          expect(e.names.map(parseNote)).toEqual(e.pitches)
          expect(e.pitches.every((n) => SCALES[scale]!.semitones.includes(mod(n - root)))).toBe(true)
        }
      }
    expect(pianoSpelling(71, 8, SCALES.minor)).toBe('Cb5')
  })
  it('preserves chord membership through every inversion', () => {
    for (const quality of ['major', 'minor', '7', 'maj7', 'm7', 'dim'])
      for (let inversion = 0; inversion < 4; inversion++) {
        const notes = pianoVoicing(60, quality, inversion)
        expect(notes).toEqual([...notes].sort((a, b) => a - b))
        expect(notes.map((n) => mod(n)).sort((a, b) => a - b)).toEqual(
          [...CHORDS[quality]!.semitones].sort((a, b) => a - b)
        )
      }
  })
  it('encodes Alberti rests and left-hand low-high-middle-high in the same events', () => {
    const events = pianoExercise({ ...pianoDefaults(), pattern: 'alberti' }).events
    expect(events.slice(0, 4).map((e) => e.left[0])).toEqual([48, 55, 52, 55])
    expect(events[1]!.right).toEqual([])
    expect(events[1]!.pitches).toEqual([55])
  })
  it('changes actual sounding chord pitches throughout twelve-bar blues', () => {
    const { events, beats } = pianoExercise({ ...pianoDefaults(), pattern: 'blues', root: 9 })
    expect(beats).toBe(48)
    expect(events).toHaveLength(12)
    expect(events[4]!.harmony).toBe('D7')
    expect(events[8]!.harmony).toBe('E7')
    const roots = [9, 9, 9, 9, 2, 2, 9, 9, 4, 2, 9, 4]
    events.forEach((e, i) =>
      expect(e.pitches.every((n) => CHORDS['7']!.semitones.includes(mod(n - roots[i]!)))).toBe(true)
    )
  })
  it('shows checked C-major fingering only for the supported patterns', () => {
    expect(pianoExercise({ ...pianoDefaults(), pattern: 'scale' }).events[3]!.fingers).toEqual({
      left: 2,
      right: 1
    })
    expect(
      pianoExercise({ ...pianoDefaults(), root: 2, pattern: 'scale' }).events.every((e) => !e.fingers)
    ).toBe(true)
  })
  it('lays black keys between white keys instead of inventing E# or B# physical keys', () => {
    const keys = keyboardLayout(60, 72)
    expect(keys.filter((k) => k.black)).toHaveLength(5)
    expect(keys.filter((k) => !k.black)).toHaveLength(8)
    expect(keys.find((k) => k.midi === 61)!.x).toBeCloseTo(0.68)
    expect(keys.find((k) => k.midi === 65)!.black).toBe(false)
  })
})
describe('expanded learning paths', () => {
  it('covers every lesson exactly once in 33 substantive chapter plans', () => {
    const chapters = Object.values(COURSES).flatMap((c) => c.chapters),
      ids = chapters.flatMap((c) => c.lessonIds)
    expect(chapters).toHaveLength(33)
    expect(new Set(ids).size).toBe(178)
    expect([...ids].sort()).toEqual(LESSONS.map((l) => l.id).sort())
    for (const chapter of chapters) {
      expect(chapter.concept.length).toBeGreaterThan(40)
      expect(chapter.drills).toHaveLength(3)
      expect(chapter.diagnosis.length).toBeGreaterThan(25)
    }
    LESSONS.forEach((l) => expect(chapterFor(l).lessonIds).toContain(l.id))
  })
  it('has 24 piano units and a substantial new application pair in every existing track', () => {
    expect(LESSONS.filter((l) => l.track === 'piano')).toHaveLength(24)
    for (const track of Object.keys(COURSES).filter((t) => t !== 'piano' && t !== 'electric'))
      expect(LESSONS.filter((l) => l.track === track && l.category === '专题应用')).toHaveLength(2)
  })
  it('extends old saved preferences while preserving ensemble parameters and favorites', () => {
    const { piano, ...old } = defaults()
    old.ensemble.synth.cutoff = 3500
    old.favorites = ['synthesis-2']
    const result = decodePreferences(JSON.stringify(old))
    expect(result.piano).toEqual(piano)
    expect(result.ensemble.synth.cutoff).toBe(3500)
    expect(result.favorites).toEqual(['synthesis-2'])
    expect(decodePreferences(JSON.stringify({ ...old, piano: { bpm: -10 } })).piano).toEqual(pianoDefaults())
  })
})
