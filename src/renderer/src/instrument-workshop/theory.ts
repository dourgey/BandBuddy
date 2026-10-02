/** Sounding pitches, never transposing-notation octaves. String arrays run high string number → 1. */
export type Instrument = 'guitar' | 'bass' | 'ukulele'
export interface Tuning {
  id: string
  name: string
  instrument: Instrument
  notes: number[]
  frets: number
}
export const TUNINGS: Tuning[] = [
  { id: 'guitar', name: '吉他 · 标准', instrument: 'guitar', notes: [40, 45, 50, 55, 59, 64], frets: 22 },
  { id: 'drop-d', name: '吉他 · Drop D', instrument: 'guitar', notes: [38, 45, 50, 55, 59, 64], frets: 22 },
  { id: 'bass', name: '贝斯 · 四弦', instrument: 'bass', notes: [28, 33, 38, 43], frets: 24 },
  { id: 'bass-5', name: '贝斯 · 五弦', instrument: 'bass', notes: [23, 28, 33, 38, 43], frets: 24 },
  { id: 'uke-high', name: '尤克里里 · 高 G', instrument: 'ukulele', notes: [67, 60, 64, 69], frets: 18 },
  { id: 'uke-low', name: '尤克里里 · 低 G', instrument: 'ukulele', notes: [55, 60, 64, 69], frets: 18 },
  { id: 'baritone', name: '尤克里里 · Baritone', instrument: 'ukulele', notes: [50, 55, 59, 64], frets: 18 }
]
export interface Material {
  name: string
  semitones: number[]
  degrees: string[]
}
const material = (name: string, semitones: number[], degrees: string): Material => ({
  name,
  semitones,
  degrees: degrees.split(' ')
})
export const SCALES: Record<string, Material> = {
  major: material('大调 / Ionian', [0, 2, 4, 5, 7, 9, 11], '1 2 3 4 5 6 7'),
  minor: material('自然小调 / Aeolian', [0, 2, 3, 5, 7, 8, 10], '1 2 b3 4 5 b6 b7'),
  'minor-pent': material('小调五声音阶', [0, 3, 5, 7, 10], '1 b3 4 5 b7'),
  'major-pent': material('大调五声音阶', [0, 2, 4, 7, 9], '1 2 3 5 6'),
  'minor-blues': material('小调布鲁斯', [0, 3, 5, 6, 7, 10], '1 b3 4 b5 5 b7'),
  'major-blues': material('大调布鲁斯', [0, 2, 3, 4, 7, 9], '1 2 b3 3 5 6'),
  dorian: material('Dorian 多利亚', [0, 2, 3, 5, 7, 9, 10], '1 2 b3 4 5 6 b7'),
  phrygian: material('Phrygian 弗里几亚', [0, 1, 3, 5, 7, 8, 10], '1 b2 b3 4 5 b6 b7'),
  lydian: material('Lydian 利底亚', [0, 2, 4, 6, 7, 9, 11], '1 2 3 #4 5 6 7'),
  mixolydian: material('Mixolydian 混合利底亚', [0, 2, 4, 5, 7, 9, 10], '1 2 3 4 5 6 b7'),
  locrian: material('Locrian 洛克里亚', [0, 1, 3, 5, 6, 8, 10], '1 b2 b3 4 b5 b6 b7'),
  harmonic: material('和声小调', [0, 2, 3, 5, 7, 8, 11], '1 2 b3 4 5 b6 7'),
  melodic: material('旋律小调（上行／爵士）', [0, 2, 3, 5, 7, 9, 11], '1 2 b3 4 5 6 7'),
  chromatic: material('半音阶', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '1 b2 2 b3 3 4 b5 5 b6 6 b7 7')
}
export const CHORDS: Record<string, Material> = {
  power: material('强力和弦 / 根五', [0, 7], '1 5'),
  major: material('大三和弦', [0, 4, 7], '1 3 5'),
  minor: material('小三和弦', [0, 3, 7], '1 b3 5'),
  dim: material('减三和弦', [0, 3, 6], '1 b3 b5'),
  aug: material('增三和弦', [0, 4, 8], '1 3 #5'),
  '7': material('属七和弦', [0, 4, 7, 10], '1 3 5 b7'),
  maj7: material('大七和弦', [0, 4, 7, 11], '1 3 5 7'),
  m7: material('小七和弦', [0, 3, 7, 10], '1 b3 5 b7'),
  m7b5: material('半减七和弦', [0, 3, 6, 10], '1 b3 b5 b7'),
  dim7: material('减七和弦', [0, 3, 6, 9], '1 b3 b5 bb7'),
  sus2: material('挂二和弦', [0, 2, 7], '1 2 5'),
  sus4: material('挂四和弦', [0, 5, 7], '1 4 5'),
  add9: material('加九和弦', [0, 4, 7, 14], '1 3 5 9')
}
export const ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
export const mod = (n: number, by = 12): number => ((n % by) + by) % by
export function parseNote(note: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]{0,2})(-?\d)$/.exec(note.trim())
  if (!m) return null
  const alteration = [...m[2]!].reduce((sum, char) => sum + ('#♯'.includes(char) ? 1 : -1), 0)
  const midi = (Number(m[3]) + 1) * 12 + NATURAL[m[1]!.toUpperCase()]! + alteration
  return midi >= 12 && midi <= 108 ? midi : null
}
export function noteName(midi: number, octave = true, flats = false): string {
  const names = flats ? ROOTS : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return names[mod(midi)]! + (octave ? Math.floor(midi / 12) - 1 : '')
}
export function spelledNote(root: string, degree: string, semitone: number): string {
  const letters = 'CDEFGAB'
  const number = Number(degree.replace(/[^0-9]/g, ''))
  const letter = letters[mod(letters.indexOf(root[0]!) + number - 1, 7)]!
  const rootPc = mod((NATURAL[root[0]!] ?? 0) + (root.includes('#') ? 1 : root.includes('b') ? -1 : 0))
  let delta = mod(rootPc + semitone - NATURAL[letter]!)
  if (delta > 6) delta -= 12
  return letter + (delta >= 0 ? '#'.repeat(delta) : 'b'.repeat(-delta))
}
export function materialNotes(root: number, value: Material): string[] {
  return value.semitones.map((n, i) => spelledNote(ROOTS[mod(root)]!, value.degrees[i]!, n))
}
export const frequency = (midi: number, a4 = 440): number => a4 * 2 ** ((midi - 69) / 12)
export interface Position {
  string: number
  fret: number
  midi: number
}
export function positions(tuning: Tuning, capo: number, min: number, max: number, strings: number[] = []): Position[] {
  const result: Position[] = []
  tuning.notes.forEach((open, index) => {
    const string = tuning.notes.length - index
    if (strings.length && !strings.includes(string)) return
    for (let fret = Math.max(0, min); fret <= Math.min(max, tuning.frets - capo); fret++)
      result.push({ string, fret, midi: open + capo + fret })
  })
  return result
}
export function chordVoicings(
  tuning: Tuning,
  root: number,
  chord: Material,
  capo = 0,
  range?: { minFret: number; maxFret: number; strings: number[] }
): Position[][] {
  const required = [...new Set(chord.semitones.map((x) => mod(x + root)))]
  const results: Position[][] = []
  // Bounded search: four-fret windows, optional muted strings, at most four stopped fingers.
  for (
    let base = range?.minFret ?? 0;
    base <= Math.min(range?.maxFret ?? 12, tuning.frets - capo) && results.length < 24;
    base++
  ) {
    const choices = tuning.notes.map((open, i) =>
      [-1, ...Array.from({ length: 5 }, (_, n) => base + n)]
        .filter(
          (f) =>
            f < 0 ||
            (f <= tuning.frets - capo &&
              (!range ||
                (f >= range.minFret &&
                  f <= range.maxFret &&
                  (!range.strings.length || range.strings.includes(tuning.notes.length - i)))) &&
              required.includes(mod(open + capo + f)))
        )
        .map((fret) => (fret < 0 ? null : { string: tuning.notes.length - i, fret, midi: open + capo + fret }))
    )
    const visit = (index: number, picked: Position[]): void => {
      if (results.length >= 24) return
      if (index === choices.length) {
        if (picked.length < required.length || !required.every((pc) => picked.some((p) => mod(p.midi) === pc))) return
        const stopped = picked.filter((p) => p.fret > 0)
        if (stopped.length > 4 && new Set(stopped.map((p) => p.fret)).size > 3) return
        if (stopped.length && Math.max(...stopped.map((p) => p.fret)) - Math.min(...stopped.map((p) => p.fret)) > 3)
          return
        const signature = picked.map((p) => `${p.string}:${p.fret}`).join(',')
        if (!results.some((v) => v.map((p) => `${p.string}:${p.fret}`).join(',') === signature)) results.push(picked)
        return
      }
      for (const pos of choices[index]!) visit(index + 1, pos ? [...picked, pos] : picked)
    }
    visit(0, [])
  }
  return results
    .sort((a, b) => Math.max(...a.map((p) => p.fret)) - Math.max(...b.map((p) => p.fret)) || b.length - a.length)
    .slice(0, 6)
}
export const CIRCLE = [
  ['C', 'Am', '无升降号'],
  ['G', 'Em', '1♯'],
  ['D', 'Bm', '2♯'],
  ['A', 'F#m', '3♯'],
  ['E', 'C#m', '4♯'],
  ['B', 'G#m', '5♯'],
  ['F#', 'D#m', '6♯'],
  ['Db', 'Bbm', '5♭'],
  ['Ab', 'Fm', '4♭'],
  ['Eb', 'Cm', '3♭'],
  ['Bb', 'Gm', '2♭'],
  ['F', 'Dm', '1♭']
] as const
