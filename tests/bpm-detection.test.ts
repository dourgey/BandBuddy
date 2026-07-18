import { describe, expect, it } from 'vitest'
import { detectBpmFromSamples } from '../src/main/bpm-detection.js'

function clickTrack(bpm: number, seconds = 30, sampleRate = 4000, alternate = false, offsetMs = 0): Float32Array {
  const samples = new Float32Array(seconds * sampleRate)
  const beatSamples = sampleRate * 60 / bpm
  const offsetSamples = offsetMs / 1000 * sampleRate
  for (let beat = 0; offsetSamples + beat * beatSamples < samples.length; beat += 1) {
    const start = Math.round(offsetSamples + beat * beatSamples)
    const amplitude = alternate && beat % 2 === 1 ? 0.42 : 1
    for (let offset = 0; offset < 100 && start + offset < samples.length; offset += 1) {
      samples[start + offset] = amplitude * Math.exp(-offset / 18) * Math.sin(offset * 1.7)
    }
  }
  return samples
}

describe('BPM detection', () => {
  it('detects a regular click track', () => {
    expect(detectBpmFromSamples(clickTrack(120), 4000)?.bpm).toBeCloseTo(120, 0)
  })

  it('keeps the beat when alternating beats are quieter', () => {
    expect(Math.abs((detectBpmFromSamples(clickTrack(96, 30, 4000, true), 4000)?.bpm ?? 0) - 96)).toBeLessThanOrEqual(2)
  })

  it('keeps decimal tempo precision and locates the beat grid', () => {
    const result = detectBpmFromSamples(clickTrack(123.4, 45, 8000, false, 137), 8000)
    expect(result).not.toBeNull()
    expect(result!.bpm).toBeCloseTo(123.4, 1)
    const beatDurationMs = 60_000 / result!.bpm
    const phaseError = ((result!.beatOffsetMs - 137 + beatDurationMs / 2) % beatDurationMs + beatDurationMs) % beatDurationMs - beatDurationMs / 2
    expect(Math.abs(phaseError)).toBeLessThanOrEqual(15)
  })

  it('rejects silence', () => {
    expect(detectBpmFromSamples(new Float32Array(4000 * 10), 4000)).toBeNull()
  })

  it('rejects non-periodic noise', () => {
    const samples = new Float32Array(4000 * 20)
    let state = 0x12345678
    for (let index = 0; index < samples.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) | 0
      samples[index] = (state >>> 8) / 0x01000000 - 0.5
    }
    expect(detectBpmFromSamples(samples, 4000)).toBeNull()
  })
})
