import {
  CHORDS,
  SCALES,
  TUNINGS,
  mod,
  positions,
  type Material,
  type Position,
  type Tuning
} from './theory.js'

export type LabModule = 'notes' | 'degrees' | 'chords' | 'positions'
export type PositionSystem = 'caged' | 'three' | 'pent' | 'region'
export const LAB_TUNINGS: Tuning[] = [
  ...TUNINGS.map((t) => ({
    ...t,
    frets: t.instrument === 'ukulele' ? t.frets : 24
  })),
  {
    id: 'guitar-7',
    name: '七弦吉他 · 标准',
    instrument: 'guitar',
    notes: [35, 40, 45, 50, 55, 59, 64],
    frets: 24
  },
  {
    id: 'd-standard',
    name: '吉他 · D Standard',
    instrument: 'guitar',
    notes: [38, 43, 48, 53, 57, 62],
    frets: 24
  },
  {
    id: 'open-g',
    name: '吉他 · Open G',
    instrument: 'guitar',
    notes: [38, 43, 50, 55, 59, 62],
    frets: 24
  }
]
export const cellId = (p: Position): string => `${p.string}:${p.fret}`
export const chromaticDegrees = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7']
export const intervalNames = [
  '完全一度',
  '小二度',
  '大二度',
  '小三度',
  '大三度',
  '完全四度',
  '减五度',
  '完全五度',
  '小六度',
  '大六度',
  '小七度',
  '大七度'
]
export const prettyDegree = (degree: string): string => degree.replace(/b/g, '♭').replace(/#/g, '♯')
export const inMaterial = (p: Position, root: number, material: Material): boolean =>
  material.semitones.some((n) => mod(n) === mod(p.midi - root))
export function degreeFor(midi: number, root: number, material: Material): string {
  const index = material.semitones.findIndex((n) => mod(n) === mod(midi - root))
  return index < 0 ? chromaticDegrees[mod(midi - root)]! : prettyDegree(material.degrees[index]!)
}

export interface LabShape {
  name: string
  notes: Position[]
}
export function isStandardSix(tuning: Tuning): boolean {
  return (
    tuning.notes.length === 6 &&
    tuning.notes.every((n, i) => mod(n - tuning.notes[0]!) === [0, 5, 10, 3, 7, 0][i])
  )
}
/** Major-scale notes around the five movable chord forms, in low-to-high string order. */
const CAGED_FRETS = [
  [
    [0, 1, 3],
    [0, 2, 3],
    [0, 2, 3],
    [0, 2],
    [0, 1, 3],
    [0, 1, 3]
  ],
  [
    [3, 5],
    [2, 3, 5],
    [2, 3, 5],
    [2, 4, 5],
    [3, 5, 6],
    [3, 5]
  ],
  [
    [5, 7, 8],
    [5, 7, 8],
    [5, 7],
    [4, 5, 7],
    [5, 6, 8],
    [5, 7, 8]
  ],
  [
    [7, 8, 10],
    [7, 8, 10],
    [7, 9, 10],
    [7, 9, 10],
    [8, 10],
    [7, 8, 10]
  ],
  [
    [10, 12, 13],
    [10, 12],
    [9, 10, 12],
    [9, 10, 12],
    [10, 12, 13],
    [10, 12, 13]
  ]
]
const PENTATONIC_FRETS = [
  [
    [0, 3],
    [0, 2],
    [0, 2],
    [0, 2],
    [0, 3],
    [0, 3]
  ],
  [
    [3, 5],
    [2, 5],
    [2, 5],
    [2, 4],
    [3, 5],
    [3, 5]
  ],
  [
    [5, 7],
    [5, 7],
    [5, 7],
    [4, 7],
    [5, 8],
    [5, 7]
  ],
  [
    [7, 10],
    [7, 10],
    [7, 9],
    [7, 9],
    [8, 10],
    [7, 10]
  ],
  [
    [10, 12],
    [10, 12],
    [9, 12],
    [9, 12],
    [10, 12],
    [10, 12]
  ]
]
export function positionShapes(
  tuning: Tuning,
  root: number,
  material: Material,
  system: PositionSystem
): LabShape[] {
  const all = positions(tuning, 0, 0, tuning.frets)
  if (system === 'caged') {
    if (!isStandardSix(tuning)) return []
    const transpose = mod(root - mod(tuning.notes[0]! - 4))
    return ['C', 'A', 'G', 'E', 'D'].map((name, index) => {
      const pattern = CAGED_FRETS[index]!
      const offset = Math.min(...pattern.flat()) + transpose >= 12 ? transpose - 12 : transpose
      const notes = tuning.notes
        .flatMap((open, stringIndex) =>
          pattern[stringIndex]!.map((fret) => ({
            string: 6 - stringIndex,
            fret: fret + offset,
            midi: open + fret + offset
          }))
        )
        .filter((p) => p.fret >= 0 && p.fret <= tuning.frets && inMaterial(p, root, material))
      return { name: `${name} Shape`, notes }
    })
  }
  if (system === 'region')
    return [
      {
        name: '自定义区域',
        notes: all.filter((p) => inMaterial(p, root, material))
      }
    ]
  if (system === 'pent' && isStandardSix(tuning)) {
    const minorRoot = mod(root - (material.semitones.includes(4) ? 3 : 0))
    const anchor = mod(minorRoot - tuning.notes[0]!)
    return PENTATONIC_FRETS.map((pattern, index) => {
      const offset = Math.min(...pattern.flat()) + anchor >= 12 ? anchor - 12 : anchor
      return {
        name: `Box ${index + 1}`,
        notes: tuning.notes
          .flatMap((open, stringIndex) =>
            pattern[stringIndex]!.map((fret) => ({
              string: 6 - stringIndex,
              fret: fret + offset,
              midi: open + fret + offset
            }))
          )
          .filter((p) => p.fret >= 0 && p.fret <= tuning.frets && inMaterial(p, root, material))
      }
    })
  }
  const count = system === 'three' ? material.semitones.length : 5
  const perString = system === 'three' ? 3 : 2
  const low = tuning.notes[0]!
  const starts = all
    .filter((p) => p.string === tuning.notes.length && p.fret <= 12 && inMaterial(p, root, material))
    .sort((a, b) => a.fret - b.fret)
  return Array.from({ length: count }, (_, index) => {
    const first = starts[index]
    if (!first) return { name: `Position ${index + 1}`, notes: [] }
    const notes: Position[] = []
    let lastMidi = low + first.fret - 1
    tuning.notes.forEach((open, stringIndex) => {
      const available = all.filter(
        (p) => p.string === tuning.notes.length - stringIndex && inMaterial(p, root, material)
      )
      const selected =
        system === 'three'
          ? available.filter((p) => p.midi > lastMidi).slice(0, perString)
          : available
              .filter((p) => p.fret >= first.fret - (mod(open - low) === 7 ? 1 : 0))
              .slice(0, perString)
      notes.push(...selected)
      if (selected.length) lastMidi = selected.at(-1)!.midi
    })
    return {
      name: `${system === 'pent' ? 'Box' : 'Position'} ${index + 1}`,
      notes
    }
  }).filter((shape) => shape.notes.length === tuning.notes.length * perString)
}

/** Every result contains exactly one note per selected string and all three chord tones. */
export function triadShapes(
  tuning: Tuning,
  root: number,
  chord: Material,
  strings: number[],
  min: number,
  max: number
): LabShape[] {
  if (chord.semitones.length !== 3 || strings.length !== 3) return []
  const all = positions(tuning, 0, min, max, strings).filter((p) => inMaterial(p, root, chord))
  const groups = strings.map((string) => all.filter((p) => p.string === string))
  const result: LabShape[] = []
  for (const a of groups[0]!)
    for (const b of groups[1]!)
      for (const c of groups[2]!) {
        const notes = [a, b, c]
        if (
          new Set(notes.map((p) => mod(p.midi))).size !== 3 ||
          Math.max(...notes.map((p) => p.fret)) - Math.min(...notes.map((p) => p.fret)) > 4
        )
          continue
        const bass = [...notes].sort((x, y) => x.midi - y.midi)[0]!
        const inversion = chord.semitones.findIndex((n) => mod(n) === mod(bass.midi - root))
        result.push({
          name: ['原位', '第一转位', '第二转位'][inversion]!,
          notes
        })
      }
  return result.sort(
    (a, b) => Math.min(...a.notes.map((p) => p.fret)) - Math.min(...b.notes.map((p) => p.fret))
  )
}

export interface CellProgress {
  correct: number
  wrong: number
  totalMs: number
}
export interface LabProgress {
  version: 1
  cells: Record<string, CellProgress>
  modules: Record<LabModule, { correct: number; wrong: number }>
  days: Record<string, number>
}
export const freshProgress = (): LabProgress => ({
  version: 1,
  cells: {},
  modules: {
    notes: { correct: 0, wrong: 0 },
    degrees: { correct: 0, wrong: 0 },
    chords: { correct: 0, wrong: 0 },
    positions: { correct: 0, wrong: 0 }
  },
  days: {}
})
export const tuningKey = (tuning: Tuning): string => tuning.notes.join(',')
export const progressKey = (tuning: Tuning, p: Position): string => `${tuningKey(tuning)}/${cellId(p)}`
export function recordAnswer(
  progress: LabProgress,
  tuning: Tuning,
  module: LabModule,
  p: Position,
  correct: boolean,
  elapsed: number
): LabProgress {
  const key = progressKey(tuning, p)
  const cell = progress.cells[key] ?? { correct: 0, wrong: 0, totalMs: 0 }
  const score = progress.modules[module]
  return {
    ...progress,
    cells: {
      ...progress.cells,
      [key]: {
        correct: cell.correct + Number(correct),
        wrong: cell.wrong + Number(!correct),
        totalMs: cell.totalMs + (correct ? Math.max(0, elapsed) : 0)
      }
    },
    modules: {
      ...progress.modules,
      [module]: {
        correct: score.correct + Number(correct),
        wrong: score.wrong + Number(!correct)
      }
    }
  }
}
export function mastery(cell?: CellProgress): number | null {
  if (!cell || cell.correct + cell.wrong === 0) return null
  const accuracy = cell.correct / (cell.correct + cell.wrong)
  const speed = cell.correct ? Math.min(1, 4000 / Math.max(1, cell.totalMs / cell.correct)) : 0
  return accuracy * speed * Math.min(1, (cell.correct + cell.wrong) / 3)
}
export function weakPositions(progress: LabProgress, tuning: Tuning): Position[] {
  return positions(tuning, 0, 0, tuning.frets)
    .map((p) => ({ p, score: mastery(progress.cells[progressKey(tuning, p)]) }))
    .filter((item): item is { p: Position; score: number } => item.score !== null && item.score < 0.85)
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((item) => item.p)
}
export function choosePracticePosition(
  pool: Position[],
  progress: LabProgress,
  tuning: Tuning,
  previous?: Position,
  random = Math.random
): Position | null {
  if (!pool.length) return null
  const candidates = pool.length > 1 ? pool.filter((p) => cellId(p) !== (previous && cellId(previous))) : pool
  const weighted = candidates.map((p) => ({
    p,
    weight: 1 + (1 - (mastery(progress.cells[progressKey(tuning, p)]) ?? 0)) * 3
  }))
  let pick = random() * weighted.reduce((sum, item) => sum + item.weight, 0)
  for (const item of weighted) {
    pick -= item.weight
    if (pick < 0) return item.p
  }
  return weighted.at(-1)!.p
}
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
export function readProgress(): LabProgress {
  const empty = freshProgress()
  try {
    const raw = JSON.parse(localStorage.getItem('bandbuddy.fretboard-progress.v1') ?? 'null')
    if (raw?.version !== 1) return empty
    for (const [key, value] of Object.entries(raw.cells ?? {})) {
      const cell = value as CellProgress
      if (cell && nonnegative(cell.correct) && nonnegative(cell.wrong) && nonnegative(cell.totalMs))
        empty.cells[key] = cell
    }
    for (const module of Object.keys(empty.modules) as LabModule[]) {
      const score = raw.modules?.[module]
      if (score && nonnegative(score.correct) && nonnegative(score.wrong)) empty.modules[module] = score
    }
    for (const [day, seconds] of Object.entries(raw.days ?? {}))
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && nonnegative(seconds)) empty.days[day] = seconds
  } catch {
    /* A corrupt record must not prevent practice. */
  }
  return empty
}
export const TRAINING_STAGES = [
  {
    name: '空弦与 12 品',
    module: 'notes',
    range: [0, 12],
    strings: 'all',
    task: 'identify',
    naturals: false,
    boundary: true
  },
  {
    name: '低音弦自然音',
    module: 'notes',
    range: [0, 5],
    strings: 'low',
    task: 'find',
    naturals: true
  },
  {
    name: '全弦自然音',
    module: 'notes',
    range: [0, 12],
    strings: 'all',
    task: 'recall',
    naturals: true
  },
  {
    name: '升降音',
    module: 'notes',
    range: [0, 12],
    strings: 'all',
    task: 'identify',
    naturals: false
  },
  {
    name: '同音与八度位置',
    module: 'notes',
    range: [0, 12],
    strings: 'all',
    task: 'find',
    naturals: false
  },
  {
    name: 'Root → 3 / ♭3',
    module: 'degrees',
    range: [0, 9],
    strings: 'all',
    degree: [3, 4]
  },
  {
    name: 'Root → 5',
    module: 'degrees',
    range: [0, 12],
    strings: 'all',
    degree: [7]
  },
  {
    name: 'Root → 7 / ♭7',
    module: 'degrees',
    range: [0, 12],
    strings: 'all',
    degree: [10, 11]
  },
  {
    name: '三和弦音',
    module: 'chords',
    range: [5, 9],
    strings: 'all',
    chord: 'major'
  },
  {
    name: '七和弦音',
    module: 'chords',
    range: [5, 9],
    strings: 'all',
    chord: 'm7'
  },
  {
    name: '重建 CAGED',
    module: 'positions',
    range: [0, 12],
    strings: 'all',
    system: 'caged'
  },
  {
    name: '3NPS / 五声音阶',
    module: 'positions',
    range: [0, 15],
    strings: 'all',
    system: 'three'
  },
  {
    name: '和弦进行 · ii–V–I',
    module: 'chords',
    range: [5, 9],
    strings: 'all',
    changes: true
  }
] as const
export { CHORDS, SCALES }
