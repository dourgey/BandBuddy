import type { PianoConfig } from './piano.js'
import type { ElectricConfig } from './electric.js'
import type { EnsemblePrefs } from './ensemble.js'
import type { Instrument, Position } from './theory.js'
export type Section = 'learn' | 'lab' | 'practice' | 'tools'
export type Pattern =
  | 'scale'
  | 'three'
  | 'four'
  | 'thirds'
  | 'return'
  | 'reorder'
  | 'triads'
  | 'sevenths'
  | 'rhythm'
  | 'blues'
  | 'chromatic'
  | 'chord'
export type Technique = 'hammer' | 'pull' | 'slide' | 'bend' | 'vibrato' | 'mute' | 'down' | 'up' | 'tap'
export interface MusicEvent {
  id: string
  beat: number
  duration: number
  notes: Position[]
  technique?: Technique
  bend?: number
  tie?: boolean
  palmMute?: boolean
  accent?: boolean
  velocity?: number
  gate?: number
}
export interface ExerciseConfig {
  root: number
  scale: string
  chord: string
  material: 'scale' | 'chord'
  pattern: Pattern
  direction: 'up' | 'down' | 'both'
  sequence: 'diatonic' | 'chromatic'
  step: number
  minFret: number
  maxFret: number
  strings: number[]
  bpm: number
  meter: string
  subdivision: number
  swing: number
  countIn: number
  rounds: number
  speedStep: number
  loopStart: number
  loopEnd: number
  backing: string
  drums: number
  bass: number
  harmony: number
  mode: 'demo' | 'follow' | 'apply'
  hint: 'all' | 'roots' | 'none'
  backbeat: boolean
  silentBars: number
}
export interface Lesson {
  id: string
  track: 'shared' | Instrument | 'blues' | 'drums' | 'violin' | 'synthesis' | 'piano' | 'electric'
  category: string
  level: 1 | 2 | 3
  title: string
  goal: string
  explanation: string
  example: string
  steps: string[]
  mistakes: string
  check: string
  easier: string
  harder: string
  prerequisites: string[]
  related: string[]
  exercise: Partial<ExerciseConfig>
  workshopPreset?: string
  guitarProjectId?: string
  guitarStage?: 0 | 1 | 2
  technique?: Technique
  view?: 'tab' | 'chord' | 'rhythm'
}
export interface Preferences {
  version: 1
  piano: PianoConfig
  electric: ElectricConfig
  ensemble: EnsemblePrefs
  section: Section
  tuningId: string
  customNotes: number[] | null
  capo: number
  leftHanded: boolean
  labels: 'notes' | 'degrees' | 'chord'
  favorites: string[]
  lessonId: string
  exercise: ExerciseConfig
  a4: number
  inputDevice: string
  droneFifth: boolean
  scrollPositions: Record<Section, number>
}
export const DEFAULT_EXERCISE: ExerciseConfig = {
  root: 0,
  scale: 'major',
  chord: 'major',
  material: 'scale',
  pattern: 'scale',
  direction: 'up',
  sequence: 'diatonic',
  step: 1,
  minFret: 0,
  maxFret: 5,
  strings: [],
  bpm: 70,
  meter: '4/4',
  subdivision: 2,
  swing: 0.5,
  countIn: 1,
  rounds: 4,
  speedStep: 0,
  loopStart: 1,
  loopEnd: 0,
  backing: 'drone',
  drums: 0.35,
  bass: 0.25,
  harmony: 0.2,
  mode: 'demo',
  hint: 'all',
  backbeat: false,
  silentBars: 0
}
export const PATTERNS: Record<Pattern, string> = {
  scale: '顺阶',
  three: '三音组 123',
  four: '四音组 1234',
  thirds: '三度 13',
  return: '往返 1232',
  reorder: '重组 1324',
  triads: '三和弦组 135',
  sevenths: '七和弦组 1357',
  rhythm: '节奏与休止',
  blues: '布鲁斯问答',
  chromatic: '半音指序',
  chord: '和弦分解 / 扫弦'
}
