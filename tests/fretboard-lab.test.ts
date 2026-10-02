import { describe, expect, it } from 'vitest'
import { CHORDS, SCALES, mod, positions } from '../src/renderer/src/woodshed/theory.js'
import {
  choosePracticePosition,
  freshProgress,
  inMaterial,
  LAB_TUNINGS,
  mastery,
  positionShapes,
  progressKey,
  recordAnswer,
  triadShapes
} from '../src/renderer/src/woodshed/lab-model.js'

const guitar = LAB_TUNINGS[0]!
describe('fretboard laboratory musical correctness', () => {
  it('preserves actual pitches and the seventh low B, without changing shared instrument presets', () => {
    expect(LAB_TUNINGS.find((t) => t.id === 'guitar-7')!.notes).toEqual([35, 40, 45, 50, 55, 59, 64])
    expect(guitar.frets).toBe(24)
    for (const tuning of LAB_TUNINGS)
      expect(positions(tuning, 0, 12, 12).map((p) => p.midi)).toEqual(tuning.notes.map((n) => n + 12))
  })
  it('transposes the five CAGED forms into every key and rejects incompatible tuning', () => {
    for (let root = 0; root < 12; root++) {
      const shapes = positionShapes(guitar, root, SCALES.major!, 'caged')
      expect(shapes).toHaveLength(5)
      for (const shape of shapes) {
        expect(new Set(shape.notes.map((p) => p.string)).size).toBe(6)
        expect(shape.notes.every((p) => inMaterial(p, root, SCALES.major!))).toBe(true)
        expect(shape.notes.some((p) => mod(p.midi) === root)).toBe(true)
        expect(shape.notes.every((p) => p.fret >= 0 && p.fret <= 24)).toBe(true)
      }
    }
    expect(
      positionShapes(
        LAB_TUNINGS.find((t) => t.id === 'open-g')!,
        0,
        SCALES.major!,
        'caged'
      )
    ).toEqual([])
  })
  it('generates seven continuous 3NPS positions with three notes per string', () => {
    for (let root = 0; root < 12; root++) {
      const shapes = positionShapes(guitar, root, SCALES.major!, 'three')
      expect(shapes).toHaveLength(7)
      for (const shape of shapes) {
        for (let string = 1; string <= 6; string++)
          expect(shape.notes.filter((p) => p.string === string)).toHaveLength(3)
        expect(shape.notes.every((p) => inMaterial(p, root, SCALES.major!))).toBe(true)
      }
    }
  })
  it('keeps two notes per string in all five major and minor pentatonic boxes', () => {
    for (const scale of [SCALES['minor-pent']!, SCALES['major-pent']!])
      for (let root = 0; root < 12; root++) {
        const shapes = positionShapes(guitar, root, scale, 'pent')
        expect(shapes).toHaveLength(5)
        for (const shape of shapes) {
          expect(shape.notes).toHaveLength(12)
          expect(shape.notes.every((p) => inMaterial(p, root, scale))).toBe(true)
          for (let string = 1; string <= 6; string++)
            expect(shape.notes.filter((p) => p.string === string)).toHaveLength(2)
        }
      }
    const first = positionShapes(guitar, 9, SCALES['minor-pent']!, 'pent')[0]!
    expect(first.notes.filter((p) => p.string === 6).map((p) => p.fret)).toEqual([5, 8])
  })
  it('finds real triad inversions with one tone on each string', () => {
    for (const chord of [CHORDS.major!, CHORDS.minor!])
      for (let root = 0; root < 12; root++)
        for (let group = 1; group <= 4; group++) {
          const shapes = triadShapes(guitar, root, chord, [group, group + 1, group + 2], 0, 15)
          expect(shapes.length).toBeGreaterThan(0)
          expect(new Set(shapes.map((s) => s.name)).size).toBe(3)
          for (const shape of shapes) {
            expect(shape.notes).toHaveLength(3)
            expect(new Set(shape.notes.map((p) => p.string)).size).toBe(3)
            expect(new Set(shape.notes.map((p) => mod(p.midi))).size).toBe(3)
            expect(shape.notes.every((p) => inMaterial(p, root, chord))).toBe(true)
          }
        }
  })
})
describe('fretboard practice evidence', () => {
  it('keeps progress separate for distinct tunings and modules', () => {
    const p = { string: 5, fret: 3, midi: 48 }
    const result = recordAnswer(freshProgress(), guitar, 'notes', p, true, 2100)
    expect(result.modules.notes).toEqual({ correct: 1, wrong: 0 })
    expect(result.modules.degrees).toEqual({ correct: 0, wrong: 0 })
    expect(result.cells[progressKey(guitar, p)]).toEqual({
      correct: 1,
      wrong: 0,
      totalMs: 2100
    })
    expect(result.cells[progressKey(LAB_TUNINGS[1]!, p)]).toBeUndefined()
  })
  it('accounts for mistakes, slow recall, and insufficient practice in the heatmap', () => {
    expect(mastery()).toBeNull()
    expect(mastery({ correct: 0, wrong: 2, totalMs: 0 })).toBe(0)
    expect(mastery({ correct: 1, wrong: 0, totalMs: 1000 })).toBeCloseTo(1 / 3)
    expect(mastery({ correct: 3, wrong: 0, totalMs: 3000 })).toBe(1)
    expect(mastery({ correct: 3, wrong: 0, totalMs: 24000 })).toBe(0.5)
  })
  it('avoids repeating the previous location and handles an empty scope', () => {
    const pool = positions(guitar, 0, 0, 0)
    expect(choosePracticePosition([], freshProgress(), guitar)).toBeNull()
    expect(choosePracticePosition(pool, freshProgress(), guitar, pool[0], () => 0)).toEqual(pool[1])
    expect(choosePracticePosition([pool[0]!], freshProgress(), guitar, pool[0], () => 0)).toEqual(pool[0])
  })
})
