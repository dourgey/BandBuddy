import { describe, expect, it } from 'vitest'
import { detectPolyStrings } from '../src/renderer/src/woodshed/poly-pitch.js'

const rate = 48000
const notes = [38, 45, 50, 55, 59, 64]
function guitarSignal(midi: number[], offsets: Record<number, number> = {}): Float32Array {
  const samples = new Float32Array(8192)
  for (let i = 0; i < samples.length; i++) {
    for (const note of midi) {
      const frequency = 440 * 2 ** ((note - 69) / 12) * 2 ** ((offsets[note] ?? 0) / 1200)
      for (let harmonic = 1; harmonic <= 6; harmonic++)
        samples[i] = samples[i]! + (0.12 / harmonic) * Math.sin((2 * Math.PI * frequency * harmonic * i) / rate)
    }
  }
  return samples
}

describe('tuning-constrained string detector', () => {
  it('does not turn one low string harmonics into a chord', () => {
    const detected = detectPolyStrings(guitarSignal([38]), rate, notes, 440)
    expect(detected.filter(Boolean).length).toBe(1)
    expect(detected[0]?.midi).toBe(38)
  })
  it('identifies two independently sounding strings', () => {
    const detected = detectPolyStrings(guitarSignal([38, 55]), rate, notes, 440)
    expect(detected[0]?.midi).toBe(38)
    expect(detected[3]?.midi).toBe(55)
  })
  it('does not count standard low E harmonics as extra strings', () => {
    const standard = [40, 45, 50, 55, 59, 64]
    const detected = detectPolyStrings(guitarSignal([40]), rate, standard, 440)
    expect(detected.filter(Boolean).length).toBe(1)
  })
  it('keeps all six measured strings in a clean strum', () => {
    const detected = detectPolyStrings(guitarSignal(notes), rate, notes, 440)
    expect(detected.filter(Boolean).length).toBe(6)
    expect(detected.every((result) => result && Math.abs(result.cents) <= 5)).toBe(true)
  })
  it('reports the cents direction on a detuned string', () => {
    const detected = detectPolyStrings(guitarSignal(notes, { 55: -12 }), rate, notes, 440)
    expect(detected[3]?.cents).toBeLessThan(-6)
    expect(detected[3]?.cents).toBeGreaterThan(-18)
  })
})
