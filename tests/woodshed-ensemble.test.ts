import { describe, expect, it } from 'vitest'
import { LESSONS } from '../src/renderer/src/woodshed/curriculum.js'
import {
  ensembleDefaults,
  DRUM_PRESETS,
  drumEvents,
  violinEvents,
  violinPositions,
  VIOLIN,
  polyrhythmEvents,
  delayTimes,
  envelopeAt,
  applyWorkshopPreset
} from '../src/renderer/src/woodshed/ensemble.js'
import { defaults, decodePreferences } from '../src/renderer/src/woodshed/preferences.js'
import { parseNote } from '../src/renderer/src/woodshed/theory.js'
describe('expanded musicians curriculum and state', () => {
  it('has 14 drum, 14 violin and 20 synthesis original units with complete exercises', () => {
    for (const [track, count] of [
      ['drums', 14],
      ['violin', 14],
      ['synthesis', 20]
    ] as const) {
      const units = LESSONS.filter((l) => l.track === track)
      expect(units).toHaveLength(count)
      for (const l of units) {
        expect(l.explanation.length).toBeGreaterThan(60)
        expect(l.steps).toHaveLength(3)
        expect(l.workshopPreset).toBeTruthy()
        for (const text of [l.goal, l.example, l.mistakes, l.check, l.easier, l.harder])
          expect(text.length).toBeGreaterThan(5)
      }
    }
  })
  it('upgrades old version 1 preferences without losing favorites or position', () => {
    const p = defaults()
    const { ensemble, ...old } = p
    old.favorites = ['blues-1']
    old.lessonId = 'blues-1'
    old.scrollPositions.learn = 421
    const result = decodePreferences(JSON.stringify(old))
    expect(result.ensemble).toEqual(ensemble)
    expect(result.favorites).toEqual(['blues-1'])
    expect(result.scrollPositions.learn).toBe(421)
  })
  it('recovers only invalid tool data and accepts all 178 favorites', () => {
    const p = defaults()
    p.favorites = LESSONS.map((l) => l.id)
    p.lessonId = 'synthesis-18'
    const result = decodePreferences(
      JSON.stringify({ ...p, ensemble: { ...p.ensemble, drum: { ...p.ensemble.drum, grid: [[99]] } } })
    )
    expect(result.ensemble).toEqual(ensembleDefaults())
    expect(result.favorites).toHaveLength(178)
    expect(result.lessonId).toBe('synthesis-18')
  })
  it('keeps preset grids independent from edits and other instrument settings', () => {
    const p = ensembleDefaults(),
      result = applyWorkshopPreset(p, 'drums', 'paradiddle')
    result.drum.grid[1]![0] = 0
    expect(DRUM_PRESETS.paradiddle!.grid[1]![0]).toBe(2)
    expect(result.violin).toEqual(p.violin)
  })
})
describe('drum timing and explicit rests', () => {
  it('converts every nonzero grid cell into exactly one matching hit', () => {
    for (const preset of Object.values(DRUM_PRESETS)) {
      const events = drumEvents(preset.grid, 0.5)
      expect(events).toHaveLength(preset.grid.flat().filter(Boolean).length)
      events.forEach((e) => {
        expect(e.beat).toBe(e.step / 4)
        expect(e.beat).toBeLessThan(4)
        expect(e.velocity).toBeGreaterThan(0)
      })
    }
    expect(
      drumEvents(
        Array.from({ length: 3 }, () => Array(16).fill(0)),
        0.5
      )
    ).toEqual([])
  })
  it('moves offbeat eighths without moving the main beat or losing events', () => {
    const events = drumEvents(DRUM_PRESETS.shuffle!.grid, 2 / 3).filter((e) => e.voice === 'hat')
    expect(events[1]!.beat).toBeCloseTo(2 / 3)
    expect(events[2]!.beat).toBe(1)
  })
  it('places 3:2 and 4:3 in a shared four-beat cycle', () => {
    for (const [a, b] of [
      [3, 2],
      [4, 3]
    ]) {
      const events = polyrhythmEvents(a!, b!)
      expect(events.filter((e) => e.beat === 0)).toHaveLength(2)
      expect(events.filter((e) => e.voice === 'snare').map((e) => e.beat)).toEqual(
        Array.from({ length: a! }, (_, i) => (4 * i) / a!)
      )
      expect(events.every((e) => e.beat < 4)).toBe(true)
    }
  })
})
describe('unfretted violin pitches and notation', () => {
  it('uses real G3 D4 A4 E5 pitches', () => expect(VIOLIN.notes).toEqual([55, 62, 69, 76]))
  it('creates playable octave scales in every key and spells notes consistently', () => {
    for (let root = 0; root < 12; root++)
      for (const scale of ['major', 'minor'] as const) {
        const config = { ...ensembleDefaults().violin, root, scale, pattern: 'scale' as const },
          events = violinEvents(config)
        expect(events).toHaveLength(15)
        expect(events[7]!.midi! - events[0]!.midi!).toBe(12)
        expect(events[14]!.midi).toBe(events[0]!.midi)
        events.forEach((e) => {
          expect(e.midi).toBe(VIOLIN.notes[e.string!]! + e.offset!)
          expect(e.offset).toBeLessThanOrEqual(7)
          expect(e.duration).toBe(2)
          if (e.name) expect(parseNote(e.name)).toBe(e.midi)
        })
      }
  })
  it('represents G major low C and high F# fingers correctly', () => {
    const notes = violinPositions(7, 'major')
    expect(notes.find((n) => n.string === 1 && n.midi === 66)?.finger).toBe('高 2')
    expect(notes.find((n) => n.string === 2 && n.midi === 72)?.finger).toBe('低 2')
  })
  it('crosses to A from the highest E string instead of repeating E', () => {
    const events = violinEvents({ ...ensembleDefaults().violin, string: 3, pattern: 'cross' })
    expect(events.map((e) => e.midi)).toEqual([76, 69, 76, 69])
  })
})
describe('synth envelope and tempo calculations', () => {
  it('releases from the actual attack level for a short gate', () => {
    const p = { ...ensembleDefaults().synth, attack: 2, release: 1 }
    expect(envelopeAt(0.5, 0.5, p)).toBeCloseTo(0.25)
    expect(envelopeAt(1, 0.5, p)).toBeCloseTo(0.125)
    expect(envelopeAt(1.5, 0.5, p)).toBe(0)
  })
  it('treats sustain as a level and gate as independent from decay', () => {
    const p = { ...ensembleDefaults().synth, attack: 0.1, decay: 0.2, sustain: 0.4, release: 0.5 }
    expect(envelopeAt(0.1, 2, p)).toBe(1)
    expect(envelopeAt(1, 2, p)).toBe(0.4)
    expect(envelopeAt(2.5, 2, p)).toBe(0)
  })
  it('computes dotted eighth and triplet eighth at 120 BPM', () => {
    const t = delayTimes(120)
    expect(t.quarter).toBe(500)
    expect(t.dottedEighth).toBe(375)
    expect(t.tripletEighth).toBeCloseTo(500 / 3)
  })
})
