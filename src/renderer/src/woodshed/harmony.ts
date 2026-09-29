import { CHORDS, SCALES, ROOTS, mod, spelledNote, type Material } from './theory.js'

export type HarmonyMode = 'key' | 'chord' | 'scale' | 'progression'
export type HarmonyInstrument = 'guitar' | 'bass' | 'ukulele' | 'piano'
export const MAJOR_DEGREES = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']
export const MINOR_DEGREES = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']
export const PROGRESSIONS = [
  { name: 'I – V – vi – IV', degrees: [0, 4, 5, 3] },
  { name: 'I – IV – V', degrees: [0, 3, 4] },
  { name: 'vi – IV – I – V', degrees: [5, 3, 0, 4] },
  { name: 'ii – V – I', degrees: [1, 4, 0] },
  { name: 'I – vi – IV – V', degrees: [0, 5, 3, 4] }
]
export function diatonicChords(root: number, minor: boolean) {
  const scale = SCALES[minor ? 'minor' : 'major']!
  const names = scale.semitones.map((n,i) => spelledNote(harmonyRootName(root,minor),scale.degrees[i]!,n))
  return scale.semitones.map((offset, i) => {
    const third = mod(scale.semitones[(i + 2) % 7]! - offset)
    const fifth = mod(scale.semitones[(i + 4) % 7]! - offset)
    const quality = fifth === 6 ? 'dim' : third === 3 ? 'minor' : 'major'
    return { root: mod(root + offset), quality, material: CHORDS[quality]!, name: names[i]! + (quality === 'minor' ? 'm' : quality === 'dim' ? 'dim' : ''), degree: (minor ? MINOR_DEGREES : MAJOR_DEGREES)[i]! }
  })
}
export function harmonyLabels(root: number, material: Material, spelling = ROOTS[root]!): Map<number, { note: string; degree: string }> {
  const names = material.semitones.map((n,i) => spelledNote(spelling,material.degrees[i]!,n))
  return new Map(material.semitones.map((n, i) => [mod(root + n), { note: names[i]!, degree: material.degrees[i]!.replaceAll('b', '♭').replaceAll('#', '♯') }]))
}
export function keySignature(root: number, minor: boolean): string {
  const major = minor ? mod(root + 3) : root
  const circle = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
  const index = circle.indexOf(major)
  return index === 0 ? '0 ♯ · 0 ♭' : index <= 6 ? `${index} ♯` : `${12 - index} ♭`
}
export const instrumentNames: Record<HarmonyInstrument, string> = { guitar: 'Guitar', bass: 'Bass', ukulele: 'Ukulele', piano: 'Piano' }
export const harmonyRootName = (root: number, minor: boolean): string => (minor ? ['C','C#','D','D#','E','F','F#','G','G#','A','Bb','B'] : ROOTS)[root]!
export const keyName = (root: number, minor: boolean): string => `${harmonyRootName(root,minor)} ${minor ? 'Minor' : 'Major'}`
