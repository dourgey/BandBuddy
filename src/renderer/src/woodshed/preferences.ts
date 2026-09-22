import { pianoDefaults, pianoSchema } from './piano.js'
import { electricDefaults, electricSchema } from './electric.js'
import { ensembleSchema, ensembleDefaults } from './ensemble.js'
import { z } from 'zod'
import { TUNINGS, SCALES, CHORDS } from './theory.js'
import { DEFAULT_EXERCISE, PATTERNS, type Preferences } from './types.js'
import { LESSONS } from './curriculum.js'
import { BACKINGS } from './generator.js'
const known = (values: string[]) => z.string().refine((s) => values.includes(s))
const integer = (min: number, max: number) => z.number().int().min(min).max(max)
const exerciseSchema = z.object({
  root: integer(0, 11),
  scale: known(Object.keys(SCALES)),
  chord: known(Object.keys(CHORDS)),
  material: z.enum(['scale', 'chord']),
  pattern: known(Object.keys(PATTERNS)),
  direction: z.enum(['up', 'down', 'both']),
  sequence: z.enum(['diatonic', 'chromatic']),
  step: integer(1, 12),
  minFret: integer(0, 24),
  maxFret: integer(0, 24),
  strings: z.array(integer(1, 6)).max(6),
  bpm: integer(30, 240),
  meter: z.enum(['2/4', '3/4', '4/4', '6/8', '12/8', '7/8']),
  subdivision: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  swing: z.number().min(0.5).max(0.75),
  countIn: integer(0, 2),
  rounds: integer(0, 32),
  speedStep: integer(0, 10),
  loopStart: integer(1, 64),
  loopEnd: integer(0, 64),
  backing: known(Object.keys(BACKINGS)),
  drums: z.number().min(0).max(1),
  bass: z.number().min(0).max(1),
  harmony: z.number().min(0).max(1),
  mode: z.enum(['demo', 'follow', 'apply']),
  hint: z.enum(['all', 'roots', 'none']),
  backbeat: z.boolean(),
  silentBars: integer(0, 4)
})
const schema = z.object({
  version: z.literal(1),
  electric: electricSchema.catch(electricDefaults).default(electricDefaults),
  piano: pianoSchema.catch(pianoDefaults).default(pianoDefaults),
  ensemble: ensembleSchema.catch(ensembleDefaults).default(ensembleDefaults),
  section: z.enum(['learn', 'lab', 'practice', 'tools']),
  tuningId: known(TUNINGS.map((t) => t.id)),
  customNotes: z.array(integer(12, 108)).min(4).max(6).nullable(),
  capo: integer(0, 12),
  leftHanded: z.boolean(),
  labels: z.enum(['notes', 'degrees', 'chord']),
  favorites: z.array(z.string()).max(LESSONS.length),
  lessonId: z.string(),
  exercise: exerciseSchema,
  a4: integer(430, 450),
  inputDevice: z.string().max(1024),
  droneFifth: z.boolean(),
  scrollPositions: z
    .object({
      learn: z.number().min(0).max(100000),
      lab: z.number().min(0).max(100000),
      practice: z.number().min(0).max(100000),
      tools: z.number().min(0).max(100000)
    })
    .default({ learn: 0, lab: 0, practice: 0, tools: 0 })
})
export const STORAGE_KEY = 'bandbuddy.woodshed.v1'
export function defaults(): Preferences {
  return {
    version: 1,
    electric: electricDefaults(),
    piano: pianoDefaults(),
    ensemble: ensembleDefaults(),
    section: 'learn',
    tuningId: 'guitar',
    customNotes: null,
    capo: 0,
    leftHanded: false,
    labels: 'notes',
    favorites: [],
    lessonId: 'shared-1',
    exercise: { ...DEFAULT_EXERCISE, pattern: 'chromatic' },
    a4: 440,
    inputDevice: '',
    droneFifth: false,
    scrollPositions: { learn: 0, lab: 0, practice: 0, tools: 0 }
  }
}
export function decodePreferences(raw: string | null): Preferences {
  try {
    const result = schema.safeParse(JSON.parse(raw ?? 'null'))
    if (!result.success) return defaults()
    const value = result.data as Preferences
    const tuning = TUNINGS.find((t) => t.id === value.tuningId)!
    value.favorites = [...new Set(value.favorites)].filter((id) => LESSONS.some((l) => l.id === id))
    if (!LESSONS.some((l) => l.id === value.lessonId)) value.lessonId = 'shared-1'
    if (value.customNotes?.length !== tuning.notes.length) value.customNotes = null
    const max = tuning.frets - value.capo
    value.exercise.maxFret = Math.min(max, value.exercise.maxFret)
    value.exercise.minFret = Math.min(value.exercise.minFret, value.exercise.maxFret)
    value.exercise.strings = value.exercise.strings.filter((s) => s <= tuning.notes.length)
    return value
  } catch {
    return defaults()
  }
}
export function readPreferences(): Preferences {
  try {
    return decodePreferences(localStorage.getItem(STORAGE_KEY))
  } catch {
    return defaults()
  }
}
export function savePreferences(value: Preferences): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
