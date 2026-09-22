import { z } from 'zod'
import { CHORDS, SCALES, ROOTS, mod, parseNote, spelledNote } from './theory.js'
import type { LabEvent } from './ensemble.js'
export const PIANO_PATTERNS = {
  five: '五指音型',
  scale: '一八度音阶',
  contrary: '反向音阶',
  arpeggio: '和弦琶音',
  chord: '和弦与转位',
  alberti: 'Alberti 低音',
  progression: 'I–V–vi–IV 伴奏',
  blues: '十二小节布鲁斯'
}
export const pianoSchema = z
  .object({
    root: z.number().int().min(0).max(11),
    scale: z.enum(['major', 'minor', 'harmonic']),
    chord: z.enum(['major', 'minor', '7', 'maj7', 'm7', 'dim']),
    inversion: z.number().int().min(0).max(3),
    octave: z.number().int().min(3).max(4),
    pattern: z.enum(['five', 'scale', 'contrary', 'arpeggio', 'chord', 'alberti', 'progression', 'blues']),
    hands: z.enum(['both', 'left', 'right']),
    bpm: z.number().int().min(30).max(160),
    rounds: z.number().int().min(0).max(8),
    labels: z.enum(['notes', 'degrees', 'none'])
  })
  .refine((c) => c.pattern !== 'alberti' || ['major', 'minor', 'dim'].includes(c.chord), 'Alberti 预设使用三和弦')
export type PianoConfig = z.infer<typeof pianoSchema>
export const pianoDefaults = (): PianoConfig => ({
  root: 0,
  scale: 'major',
  chord: 'major',
  inversion: 0,
  octave: 4,
  pattern: 'five',
  hands: 'both',
  bpm: 60,
  rounds: 2,
  labels: 'notes'
})
export function applyPianoPreset(p: PianoConfig, preset: string): PianoConfig {
  const pattern = preset in PIANO_PATTERNS ? (preset as PianoConfig['pattern']) : 'five'
  return {
    ...p,
    ...pianoDefaults(),
    pattern,
    root: pattern === 'blues' ? 9 : 0,
    chord: pattern === 'blues' ? '7' : 'major'
  }
}
export interface PianoEvent extends LabEvent {
  right: number[]
  left: number[]
  pitches: number[]
  names: string[]
  harmony?: string
  fingers?: { right: number; left: number }
}
export function pianoSpelling(midi: number, root: number, material = SCALES.major!): string {
  const index = material.semitones.findIndex((s) => mod(s) === mod(midi - root))
  if (index < 0) return `${ROOTS[mod(midi)]}${Math.floor(midi / 12) - 1}`
  const name = spelledNote(ROOTS[root]!, material.degrees[index]!, material.semitones[index]!),
    octave = Math.floor(midi / 12) - 1
  return `${name}${octave + (midi - parseNote(`${name}${octave}`)!) / 12}`
}
export function pianoVoicing(rootMidi: number, quality: string, inversion: number): number[] {
  const intervals = CHORDS[quality]!.semitones,
    turns = mod(inversion, intervals.length)
  return [
    ...intervals.slice(turns).map((n) => rootMidi + n),
    ...intervals.slice(0, turns).map((n) => rootMidi + n + 12)
  ]
}
export function pianoExercise(c: PianoConfig): { events: PianoEvent[]; beats: number } {
  if (c.pattern === 'alberti' && !['major', 'minor', 'dim'].includes(c.chord))
    throw new Error('Alberti 预设需要三和弦，请改用和弦琶音练习七和弦。')
  const events: PianoEvent[] = [],
    base = (c.octave + 1) * 12 + c.root,
    leftBase = base - 12,
    scale = SCALES[c.scale]!
  const add = (
    right: number[],
    left: number[],
    duration: number,
    harmony?: string,
    material = scale,
    root = c.root,
    fingers?: PianoEvent['fingers']
  ) => {
    if (c.hands === 'left') right = []
    if (c.hands === 'right') left = []
    const pitches = [...left, ...right]
    events.push({
      beat: events.reduce((n, e) => n + e.duration, 0),
      duration,
      right,
      left,
      pitches,
      names: pitches.map((n) => pianoSpelling(n, root, material)),
      velocity: 0.65,
      step: events.length,
      harmony,
      fingers,
      timbre: 'piano'
    })
  }
  if (['five', 'scale', 'contrary'].includes(c.pattern)) {
    const up = c.pattern === 'five' ? scale.semitones.slice(0, 5) : [...scale.semitones, 12],
      line = [...up, ...up.slice(0, -1).reverse()]
    line.forEach((interval, i) => {
      const degree = i < up.length ? i : 2 * (up.length - 1) - i
      const contrary = c.pattern === 'contrary',
        lh = contrary ? leftBase + [...scale.semitones, 12][7 - degree]! : leftBase + interval
      const rhFinger = c.pattern === 'five' ? [1, 2, 3, 4, 5][degree]! : [1, 2, 3, 1, 2, 3, 4, 5][degree]!
      const lhFinger = c.pattern === 'five' ? [5, 4, 3, 2, 1][degree]! : [5, 4, 3, 2, 1, 3, 2, 1][degree]!
      // C major fingering is deliberately scoped; transposition does not preserve fingering.
      add(
        [base + interval],
        [lh],
        1,
        undefined,
        scale,
        c.root,
        c.root === 0 && c.scale === 'major' && !contrary ? { right: rhFinger, left: lhFinger } : undefined
      )
    })
  } else if (c.pattern === 'chord' || c.pattern === 'arpeggio' || c.pattern === 'alberti') {
    const material = CHORDS[c.chord]!,
      right = pianoVoicing(base, c.chord, c.inversion),
      left = pianoVoicing(leftBase, c.chord, c.inversion)
    if (c.pattern === 'chord')
      for (let i = 0; i < 4; i++) add(right, left, 2, `${ROOTS[c.root]} · ${material.name}`, material)
    else if (c.pattern === 'arpeggio') {
      const up = [...right, right[0]! + 12]
      ;[...up, ...up.slice(0, -1).reverse()].forEach((n) => add([n], [n - 12], 1, undefined, material))
    } else
      for (let i = 0; i < 8; i++) {
        const order = [0, 2, 1, 2],
          j = order[i % 4]!
        add(i === 0 || i === 4 ? [right[0]!] : [], [left[j]!], 1, undefined, material)
      }
  } else {
    const bars = c.pattern === 'blues' ? [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7] : [0, 7, 9, 5]
    let previous: number[] | null = null
    bars.forEach((offset, i) => {
      const quality = c.pattern === 'blues' ? '7' : i === 2 ? 'minor' : 'major',
        root = mod(c.root + offset),
        material = CHORDS[quality]!
      const candidates = [0, 1, 2]
        .flatMap((inv) => [-12, 0].map((shift) => pianoVoicing(base + offset + shift, quality, inv)))
        .filter((notes) => notes[0]! >= base - 5 && notes.at(-1)! <= base + 19)
      const distance = (notes: number[]) =>
        previous
          ? notes.reduce((sum, n, index) => sum + Math.abs(n - previous![index]!), 0)
          : Math.abs(notes[0]! - base)
      const voiced = candidates.sort((a, b) => distance(a) - distance(b))[0]!
      add(
        voiced,
        [leftBase + offset],
        4,
        `${ROOTS[root]}${quality === '7' ? '7' : quality === 'minor' ? 'm' : ''}`,
        material,
        root
      )
      previous = voiced
    })
  }
  while (events.reduce((n, e) => n + e.duration, 0) % 4 !== 0) add([], [], 1)
  return { events, beats: events.reduce((n, e) => n + e.duration, 0) }
}
export function keyboardLayout(low: number, high: number) {
  let white = 0
  return Array.from({ length: high - low + 1 }, (_, i) => {
    const midi = low + i,
      black = [1, 3, 6, 8, 10].includes(mod(midi)),
      x = black ? white - 0.32 : white++
    return { midi, black, x, width: black ? 0.64 : 1 }
  })
}
