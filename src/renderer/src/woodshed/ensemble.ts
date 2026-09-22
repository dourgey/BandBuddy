import { z } from 'zod'
import { mod, SCALES, spelledNote, ROOTS, parseNote } from './theory.js'
export type Workshop = 'drums' | 'violin' | 'synthesis' | 'piano'
export const isWorkshop = (track: string): track is Workshop => ['drums', 'violin', 'synthesis', 'piano'].includes(track)
export const VIOLIN = { id: 'violin', notes: [55, 62, 69, 76] }
const num = (min: number, max: number) => z.number().min(min).max(max)
export const ensembleSchema = z.object({
  drum: z.object({
    preset: z.string(),
    mode: z.enum(['grid', '3:2', '4:3']).default('grid'),
    bpm: num(30, 200),
    swing: num(0.5, 0.7),
    loops: z.number().int().min(0).max(16),
    grid: z.array(z.array(z.number().int().min(0).max(2)).length(16)).length(3)
  }),
  violin: z.object({
    tool: z.enum(['fingerboard', 'tuner', 'drone']).default('fingerboard'),
    root: z.number().int().min(0).max(11),
    scale: z.enum(['major', 'minor']),
    string: z.number().int().min(0).max(3),
    bpm: num(30, 120),
    bowBeats: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    pattern: z.enum(['open', 'scale', 'cross'])
  }),
  synth: z.object({
    wave: z.enum(['sine', 'triangle', 'sawtooth', 'square']),
    cutoff: num(80, 12000),
    resonance: num(0.1, 12),
    attack: num(0.01, 2),
    decay: num(0.02, 2),
    sustain: num(0.05, 1),
    release: num(0.03, 3),
    lfo: num(0, 12),
    depth: num(0, 100),
    bpm: num(30, 200),
    gate: num(0.1, 4),
    octave: z.number().int().min(2).max(5)
  })
})
export type EnsemblePrefs = z.infer<typeof ensembleSchema>
export type SynthPatch = EnsemblePrefs['synth']
export const DRUM_PRESETS: Record<string, { name: string; sticking?: string; grid: number[][]; swing?: number }> = {
  rock: {
    name: '基础八分 Groove',
    grid: [
      [2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
    ]
  },
  single: {
    name: '单击 R L',
    sticking: 'RLRLRLRLRLRLRLRL',
    grid: [Array(16).fill(0), Array(16).fill(1), Array(16).fill(0)]
  },
  double: {
    name: '双击 R R L L',
    sticking: 'RRLLRRLLRRLLRRLL',
    grid: [Array(16).fill(0), Array(16).fill(1), Array(16).fill(0)]
  },
  paradiddle: {
    name: 'Paradiddle',
    sticking: 'RLRRLRLLRLRRLRLL',
    grid: [Array(16).fill(0), [2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1], Array(16).fill(0)]
  },
  ghost: {
    name: '幽灵音与反拍',
    grid: [
      [2, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 2, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 1],
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
    ]
  },
  shuffle: {
    name: 'Shuffle 八分（比例可调）',
    swing: 2 / 3,
    grid: [
      [2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
    ]
  },
  fill: {
    name: '末拍 Fill 与回拍',
    sticking: '------------RLRL',
    grid: [
      [2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 1],
      [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0]
    ]
  }
}
export function ensembleDefaults(): EnsemblePrefs {
  return {
    drum: {
      mode: 'grid',
      preset: 'rock',
      bpm: 70,
      swing: 0.5,
      loops: 4,
      grid: DRUM_PRESETS.rock!.grid.map((r) => [...r])
    },
    violin: { tool: 'fingerboard', root: 7, scale: 'major', string: 1, bpm: 60, bowBeats: 2, pattern: 'open' },
    synth: {
      wave: 'sawtooth',
      cutoff: 1800,
      resonance: 1,
      attack: 0.03,
      decay: 0.3,
      sustain: 0.4,
      release: 0.4,
      lfo: 0,
      depth: 0,
      bpm: 100,
      gate: 1,
      octave: 3
    }
  }
}
export interface LabEvent {
  pitches?: number[]
  timbre?: 'piano'
  name?: string
  beat: number
  duration: number
  midi?: number
  voice?: 'kick' | 'snare' | 'hat' | 'click'
  velocity: number
  step: number
  string?: number
  offset?: number
  bow?: '下弓' | '上弓'
}
export function drumEvents(grid: number[][], swing: number): LabEvent[] {
  return grid
    .flatMap((row, lane) =>
      row.flatMap((v, step) =>
        v
          ? [
              {
                beat:
                  Math.floor(step / 4) +
                  (step % 4 < 2 ? ((step % 4) / 2) * swing : swing + (((step % 4) - 2) / 2) * (1 - swing)),
                duration: 0.15,
                voice: (['kick', 'snare', 'hat'] as const)[lane]!,
                velocity: v === 2 ? 0.85 : 0.35,
                step
              }
            ]
          : []
      )
    )
    .sort((a, b) => a.beat - b.beat)
}
export function polyrhythmEvents(a: number, b: number): LabEvent[] {
  return [a, b]
    .flatMap((n, lane) =>
      Array.from({ length: n }, (_, i) => ({
        beat: (4 * i) / n,
        duration: 0.1,
        voice: lane === 0 ? ('snare' as const) : ('kick' as const),
        velocity: 0.65,
        step: i
      }))
    )
    .sort((a, b) => a.beat - b.beat)
}
export const violinFinger = (offset: number): string =>
  ['0', '低 1', '1', '低 2', '高 2', '3', '高 3', '4'][offset] ?? '换把'
export function violinPositions(root: number, scale: string) {
  const material = SCALES[scale]!
  return VIOLIN.notes
    .flatMap((open, string) => Array.from({ length: 8 }, (_, offset) => ({ midi: open + offset, string, offset })))
    .filter((p) => material.semitones.includes(mod(p.midi - root)))
    .map((p) => {
      const index = material.semitones.indexOf(mod(p.midi - root))
      const spelling = spelledNote(ROOTS[root]!, material.degrees[index]!, material.semitones[index]!)
      const octave = Math.floor(p.midi / 12) - 1
      const namedMidi = parseNote(`${spelling}${octave}`)!
      return { ...p, name: `${spelling}${octave + (p.midi - namedMidi) / 12}`, finger: violinFinger(p.offset) }
    })
}
export function violinEvents(config: EnsemblePrefs['violin']): LabEvent[] {
  let notes: { midi: number; string: number; offset: number }[]
  if (config.pattern === 'open')
    notes = Array.from({ length: 4 }, () => ({ midi: VIOLIN.notes[config.string]!, string: config.string, offset: 0 }))
  else if (config.pattern === 'cross')
    notes = [
      config.string,
      config.string === 3 ? 2 : config.string + 1,
      config.string,
      config.string === 3 ? 2 : config.string + 1
    ].map((string) => ({ midi: VIOLIN.notes[string]!, string, offset: 0 }))
  else {
    const positions = violinPositions(config.root, config.scale).sort((a, b) => a.midi - b.midi || b.offset - a.offset)
    const unique = positions.filter((p, i) => i === 0 || p.midi !== positions[i - 1]!.midi)
    const start = unique.findIndex((p) => mod(p.midi) === config.root)
    const up = unique.slice(start, start + 8)
    notes = [...up, ...up.slice(0, -1).reverse()]
  }
  return notes.map((p, i) => ({
    ...p,
    beat: i * config.bowBeats,
    duration: config.bowBeats,
    velocity: 0.55,
    step: i,
    bow: i % 2 ? '上弓' : '下弓'
  }))
}
export function delayTimes(bpm: number) {
  const quarter = 60000 / bpm
  return {
    quarter,
    eighth: quarter / 2,
    dottedEighth: quarter * 0.75,
    tripletEighth: quarter / 3,
    sixteenth: quarter / 4
  }
}
export function envelopeAt(time: number, gate: number, p: SynthPatch): number {
  const held = (t: number) =>
    t < p.attack ? t / p.attack : t < p.attack + p.decay ? 1 - ((1 - p.sustain) * (t - p.attack)) / p.decay : p.sustain
  return time < 0 ? 0 : time <= gate ? held(time) : Math.max(0, held(gate) * (1 - (time - gate) / p.release))
}
export const SYNTH_PRESETS: Record<string, { name: string; patch: Partial<SynthPatch> }> = {
  init: { name: '初始锯齿', patch: {} },
  sine: { name: '纯音', patch: { wave: 'sine', cutoff: 12000 } },
  filter: { name: '低通实验', patch: { cutoff: 800, resonance: 3 } },
  pluck: { name: 'Pluck 短音', patch: { attack: 0.01, decay: 0.22, sustain: 0.08, release: 0.15, gate: 0.6 } },
  pad: { name: 'Pad 缓起', patch: { wave: 'triangle', attack: 0.8, decay: 0.5, sustain: 0.7, release: 1.5, gate: 3 } },
  lead: { name: 'Lead 持续', patch: { wave: 'square', cutoff: 2800, sustain: 0.65, gate: 1.5 } },
  bass: {
    name: 'Bass 低音',
    patch: { octave: 2, cutoff: 600, attack: 0.01, decay: 0.18, sustain: 0.3, release: 0.1, gate: 0.5 }
  },
  vibrato: { name: '音高 LFO', patch: { wave: 'triangle', lfo: 5, depth: 15, gate: 2, sustain: 0.7 } }
}
export function applyWorkshopPreset(p: EnsemblePrefs, track: Workshop, preset: string): EnsemblePrefs {
  if (track === 'drums') {
    if (preset === 'poly32') return { ...p, drum: { ...p.drum, mode: '3:2' } }
    const drum = DRUM_PRESETS[preset]
    return drum
      ? {
          ...p,
          drum: { ...p.drum, mode: 'grid', preset, grid: drum.grid.map((r) => [...r]), swing: drum.swing ?? 0.5 }
        }
      : p
  }
  if (track === 'violin')
    return {
      ...p,
      violin: {
        ...p.violin,
        tool: preset === 'tuner' ? 'tuner' : preset === 'drone' ? 'drone' : 'fingerboard',
        pattern: preset === 'scale' ? 'scale' : preset === 'cross' ? 'cross' : 'open'
      }
    }
  const synth = SYNTH_PRESETS[preset]
  return synth ? { ...p, synth: { ...ensembleDefaults().synth, ...synth.patch } } : p
}
