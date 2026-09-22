import { describe, it, expect } from 'vitest'
import {
  CHORDS,
  SCALES,
  TUNINGS,
  positions,
  materialNotes,
  frequency,
  parseNote,
  chordVoicings,
  mod
} from '../src/renderer/src/woodshed/theory.js'
import {
  generateExercise,
  progression,
  beatUnit,
  meterLength
} from '../src/renderer/src/woodshed/generator.js'
import { LESSONS } from '../src/renderer/src/woodshed/curriculum.js'
import { DEFAULT_EXERCISE } from '../src/renderer/src/woodshed/types.js'
import { decodePreferences, defaults } from '../src/renderer/src/woodshed/preferences.js'
import { detectPitch, pitchReading } from '../src/renderer/src/woodshed/pitch.js'
import { swingBeat } from '../src/renderer/src/woodshed/audio.js'
describe('woodshed sounding pitches and harmony', () => {
  it('keeps standard tuning octaves, reentrant high G and capo exact', () => {
    expect(TUNINGS[0]!.notes).toEqual([40, 45, 50, 55, 59, 64])
    expect(TUNINGS[3]!.notes[0]).toBe(23)
    for (const tuning of TUNINGS) {
      const open = positions(tuning, 0, 0, 0),
        octaves = positions(tuning, 0, 12, 12)
      expect(octaves.map((p) => p.midi)).toEqual(open.map((p) => p.midi + 12))
      expect(positions(tuning, 2, 0, 0).map((p) => p.midi)).toEqual(open.map((p) => p.midi + 2))
    }
    expect(TUNINGS[4]!.notes[0]).toBeGreaterThan(TUNINGS[4]!.notes[1]!)
  })
  it('spells diatonic letters, altered intervals and extensions rather than only chromatic aliases', () => {
    expect(materialNotes(6, SCALES.major!)).toEqual(['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#'])
    expect(materialNotes(1, SCALES.major!)).toEqual(['Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C'])
    expect(materialNotes(0, CHORDS.dim7!)).toEqual(['C', 'Eb', 'Gb', 'Bbb'])
    expect(materialNotes(0, CHORDS.add9!)).toEqual(['C', 'E', 'G', 'D'])
    expect(parseNote('G4')).toBe(67)
    expect(parseNote('B0')).toBe(23)
    expect(parseNote('G')).toBeNull()
  })
  it('returns only chord-tone voicings with every required pitch class', () => {
    for (const tuning of TUNINGS)
      for (const chord of Object.values(CHORDS)) {
        const voicings = chordVoicings(tuning, 0, chord)
        expect(voicings.length, `${tuning.id} ${chord.name}`).toBeGreaterThan(0)
        for (const v of voicings) {
          expect(new Set(v.map((p) => p.string)).size).toBe(v.length)
          for (const note of v) expect(chord.semitones.map((n) => mod(n))).toContain(mod(note.midi))
          for (const n of chord.semitones) expect(v.some((p) => mod(p.midi) === mod(n))).toBe(true)
        }
      }
  })
})
describe('woodshed exercise source of truth', () => {
  it('preserves pitch/string/fret consistency for every instrument, root and pattern', () => {
    for (const tuning of TUNINGS)
      for (let root = 0; root < 12; root++)
        for (const pattern of [
          'scale',
          'three',
          'four',
          'thirds',
          'return',
          'reorder',
          'triads',
          'sevenths',
          'rhythm',
          'blues',
          'chromatic'
        ] as const) {
          const c = { ...DEFAULT_EXERCISE, root, pattern, maxFret: tuning.frets }
          const result = generateExercise(tuning, 0, c)
          expect(result.events.length).toBeGreaterThan(0)
          expect(result.events.at(-1)!.beat + result.events.at(-1)!.duration).toBeCloseTo(result.beats, 6)
          for (const event of result.events) {
            expect(event.duration).toBeGreaterThan(0)
            for (const n of event.notes) {
              expect(n.midi).toBe(tuning.notes[tuning.notes.length - n.string]! + n.fret)
              expect(n.fret).toBeLessThanOrEqual(tuning.frets)
            }
          }
        }
  })
  it('orders high-G ukulele scales by pitch rather than string index', () => {
    const result = generateExercise(TUNINGS[4]!, 0, { ...DEFAULT_EXERCISE, maxFret: 12 })
    const pitches = result.events.flatMap((e) => e.notes.map((n) => n.midi))
    expect(pitches).toEqual([...pitches].sort((a, b) => a - b))
  })
  it('distinguishes diatonic sequences and exact semitone transposition', () => {
    const c = { ...DEFAULT_EXERCISE, pattern: 'three' as const, maxFret: 12 }
    const a = generateExercise(TUNINGS[0]!, 0, c).events.flatMap((e) => e.notes.map((n) => mod(n.midi)))
    const b = generateExercise(TUNINGS[0]!, 0, { ...c, sequence: 'chromatic', step: 2 }).events.flatMap((e) =>
      e.notes.map((n) => mod(n.midi))
    )
    expect(a.slice(0, 6)).toEqual([0, 2, 4, 2, 4, 5])
    expect(b.slice(0, 6)).toEqual([0, 2, 4, 2, 4, 6])
  })
  it('rejects impossible ranges instead of inventing positions', () => {
    expect(() =>
      generateExercise(TUNINGS[0]!, 0, {
        ...DEFAULT_EXERCISE,
        strings: [1],
        minFret: 0,
        maxFret: 1,
        pattern: 'sevenths'
      })
    ).toThrow(/范围/)
  })
  it('represents rests, compound pulse durations and triplet timing', () => {
    for (const meter of ['2/4', '3/4', '4/4', '6/8', '12/8'])
      for (const subdivision of [1, 2, 3, 4]) {
        const result = generateExercise(TUNINGS[0]!, 0, {
          ...DEFAULT_EXERCISE,
          pattern: 'rhythm',
          meter,
          subdivision
        })
        expect(result.events.some((e) => !e.notes.length)).toBe(true)
        expect(result.beats / meterLength(meter)).toBeCloseTo(result.bars)
        expect(result.events[0]!.duration).toBeCloseTo(beatUnit(meter) / subdivision)
      }
    const c = { ...DEFAULT_EXERCISE, swing: 2 / 3 }
    expect(swingBeat(0.5, c)).toBeCloseTo(2 / 3)
    expect(swingBeat(1, c)).toBe(1)
    expect(swingBeat(1 / 3, { ...c, subdivision: 3 })).toBeCloseTo(1 / 3)
  })
  it('keeps twelve-bar variants and minor harmony distinct', () => {
    expect(progression('blues', 9).map((b) => b.root)).toEqual([9, 9, 9, 9, 2, 2, 9, 9, 4, 2, 9, 4])
    expect(progression('quick', 9)[1]!.root).toBe(2)
    expect(progression('minor-blues', 9)[0]!.quality).toBe('m7')
    expect(progression('minor-blues', 9)[8]!.root).toBe(5)
  })
})
describe('curriculum and persistence', () => {
  it('has exactly 178 complete, distinct units and an acyclic prerequisite graph', () => {
    expect(LESSONS).toHaveLength(178)
    expect(new Set(LESSONS.map((l) => l.title)).size).toBe(178)
    for (const track of ['shared', 'guitar', 'bass', 'ukulele', 'blues'])
      expect(LESSONS.filter((l) => l.track === track)).toHaveLength(track === 'shared' ? 26 : 14)
    const seen = new Set<string>()
    for (const l of LESSONS) {
      for (const prereq of l.prerequisites) expect(seen.has(prereq), `${l.id} requires ${prereq}`).toBe(true)
      seen.add(l.id)
      for (const field of [
        'goal',
        'explanation',
        'example',
        'mistakes',
        'check',
        'easier',
        'harder'
      ] as const)
        expect(l[field].length, `${l.id}.${field}`).toBeGreaterThan(3)
      expect(l.steps).toHaveLength(3)
      l.related.forEach((id) => expect(LESSONS.some((l) => l.id === id)).toBe(true))
    }
  })
  it('recovers from corrupt, stale or out-of-range saved settings', () => {
    expect(decodePreferences('bad')).toEqual(defaults())
    expect(decodePreferences(JSON.stringify({ ...defaults(), version: 3 }))).toEqual(defaults())
    expect(
      decodePreferences(JSON.stringify({ ...defaults(), exercise: { ...DEFAULT_EXERCISE, bpm: Infinity } }))
    ).toEqual(defaults())
    const value = {
      ...defaults(),
      favorites: ['shared-1', 'shared-1', 'missing'],
      lessonId: 'missing',
      customNotes: [40, 45, 50, 55]
    }
    const saved = decodePreferences(JSON.stringify(value))
    expect(saved.favorites).toEqual(['shared-1'])
    expect(saved.lessonId).toBe('shared-1')
    expect(saved.customNotes).toBeNull()
  })
})
describe('tuner', () => {
  it('detects low B through high strings with harmonics within five cents', () => {
    for (const sampleRate of [44100, 48000])
      for (const midi of [23, 28, 40, 60, 67, 76]) {
        const hz = frequency(midi),
          samples = Float32Array.from(
            { length: 8192 },
            (_, i) =>
              0.3 * Math.sin((2 * Math.PI * hz * i) / sampleRate) +
              0.1 * Math.sin((4 * Math.PI * hz * i) / sampleRate)
          )
        const pitch = detectPitch(samples, sampleRate)
        expect(pitch.frequency, `MIDI ${midi} at ${sampleRate}`).not.toBeNull()
        expect(Math.abs(pitchReading(pitch.frequency!, 440).cents)).toBeLessThan(5)
      }
  })
  it('does not report pitch for silence or clipping and respects A4 calibration', () => {
    expect(detectPitch(new Float32Array(8192), 48000).frequency).toBeNull()
    expect(detectPitch(new Float32Array(8192).fill(1), 48000).frequency).toBeNull()
    expect(pitchReading(442, 442)).toEqual({ midi: 69, cents: 0 })
    expect(pitchReading(440, 440, 68).cents).toBeCloseTo(100)
  })
})
describe('ready-to-play curriculum presets', () => {
  it('opens every unit with a playable default for its intended instruments', () => {
    const failures: string[] = []
    for (const lesson of LESSONS) {
      const tunings =
        lesson.track === 'shared' || lesson.track === 'blues'
          ? TUNINGS.filter((t) => ['guitar', 'bass', 'uke-high'].includes(t.id))
          : TUNINGS.filter(
              (t) => t.instrument === lesson.track && ['guitar', 'bass', 'uke-high'].includes(t.id)
            )
      for (const tuning of tunings) {
        try {
          generateExercise(tuning, 0, { ...DEFAULT_EXERCISE, ...lesson.exercise }, lesson.technique)
        } catch (e) {
          failures.push(`${lesson.id} ${tuning.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})

describe('harmony context and incomplete scale ranges', () => {
  it('updates scored chord tones at every harmony change in a twelve-bar blues', () => {
    const config = {
      ...DEFAULT_EXERCISE,
      root: 9,
      material: 'chord' as const,
      chord: '7',
      pattern: 'chord' as const,
      mode: 'apply' as const,
      backing: 'blues'
    }
    const result = generateExercise(TUNINGS[0]!, 0, config)
    expect(result.bars).toBe(12)
    const bars = progression('blues', 9)
    for (const event of result.events) {
      const harmony = bars[Math.floor(event.beat / 4)]!
      const allowed = CHORDS[harmony.quality]!.semitones.map((n) => mod(n + harmony.root))
      for (const note of event.notes) expect(allowed).toContain(mod(note.midi))
    }
  })
  it('does not relabel missing scale notes as adjacent degrees or pentatonic groups as tertian chords', () => {
    const sparse = { ...TUNINGS[4]!, notes: [60, 64, 67, 72] }
    expect(() => generateExercise(sparse, 0, { ...DEFAULT_EXERCISE, maxFret: 0 })).toThrow('缺少中间音')
    expect(() =>
      generateExercise(TUNINGS[0]!, 0, { ...DEFAULT_EXERCISE, scale: 'minor-pent', pattern: 'triads' })
    ).toThrow('七声音阶')
  })
})
