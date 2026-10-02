import { LAB_TUNINGS, SCALES, CHORDS } from './lab-model.js'
import type { Tuning } from './theory.js'

export interface LabSettings {
  tuningId: string
  customNotes: number[] | null
  root: number
  scale: string
  chord: string
  min: number
  max: number
  strings: number[]
  leftHanded: boolean
}
export function readSettings(initial: Tuning): LabSettings {
  const initialId = initial.id.replace(/-custom$/, '')
  const defaults: LabSettings = {
    tuningId: LAB_TUNINGS.some((t) => t.id === initialId) ? initialId : 'guitar',
    customNotes: initial.id.endsWith('-custom') ? initial.notes : null,
    root: 0,
    scale: 'major',
    chord: 'major',
    min: 0,
    max: 12,
    strings: [],
    leftHanded: false
  }
  try {
    const raw = JSON.parse(localStorage.getItem('bandbuddy.fretboard-settings.v1') ?? 'null')
    const tuning = LAB_TUNINGS.find((t) => t.id === raw?.tuningId)
    if (!tuning) return defaults
    const savedMin = Number.isInteger(raw.min) && raw.min >= 0 && raw.min < tuning.frets ? raw.min : 0
    const savedMax =
      Number.isInteger(raw.max) && raw.max >= savedMin && raw.max <= tuning.frets
        ? raw.max
        : Math.max(savedMin, 12)
    return {
      ...defaults,
      tuningId: tuning.id,
      customNotes:
        Array.isArray(raw.customNotes) &&
        raw.customNotes.length === tuning.notes.length &&
        raw.customNotes.every((n: number) => Number.isInteger(n) && n >= 12 && n <= 108)
          ? raw.customNotes
          : null,
      root: Number.isInteger(raw.root) && raw.root >= 0 && raw.root < 12 ? raw.root : 0,
      scale: SCALES[raw.scale] ? raw.scale : 'major',
      chord: CHORDS[raw.chord] ? raw.chord : 'major',
      min: savedMin,
      max: savedMax,
      strings: Array.isArray(raw.strings)
        ? raw.strings.filter((n: number) => Number.isInteger(n) && n >= 1 && n <= tuning.notes.length)
        : [],
      leftHanded: raw.leftHanded === true
    }
  } catch {
    return defaults
  }
}
