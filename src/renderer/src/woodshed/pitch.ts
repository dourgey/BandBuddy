export interface PitchResult {
  frequency: number | null
  confidence: number
  rms: number
  peak: number
}
/** YIN difference / cumulative mean normalization, downsampled for low instrument fundamentals. */
export function detectPitch(samples: Float32Array, sampleRate: number): PitchResult {
  let sum = 0,
    peak = 0,
    mean = 0
  for (const x of samples) {
    sum += x * x
    peak = Math.max(peak, Math.abs(x))
    mean += x
  }
  const rms = Math.sqrt(sum / samples.length)
  mean /= samples.length
  const empty = { frequency: null, confidence: 0, rms, peak }
  if (rms < 0.003 || peak >= 0.995) return empty
  const factor = Math.max(1, Math.floor(sampleRate / 12000))
  const rate = sampleRate / factor
  const data = new Float32Array(Math.floor(samples.length / factor))
  for (let i = 0; i < data.length; i++) {
    let value = 0
    for (let j = 0; j < factor; j++) value += samples[i * factor + j]! - mean
    data[i] = value / factor
  }
  const maxTau = Math.min(Math.floor(rate / 25), Math.floor(data.length / 2) - 1),
    minTau = Math.max(2, Math.floor(rate / 1400))
  const size = data.length - maxTau
  const difference = new Float32Array(maxTau + 1)
  let running = 0
  for (let tau = 1; tau <= maxTau; tau++) {
    let value = 0
    for (let i = 0; i < size; i++) {
      const delta = data[i]! - data[i + tau]!
      value += delta * delta
    }
    running += value
    difference[tau] = running > 0 ? (value * tau) / running : 1
  }
  for (let tau = minTau; tau < maxTau - 1; tau++) {
    if (difference[tau]! >= 0.15) continue
    while (tau + 1 < maxTau && difference[tau + 1]! < difference[tau]!) tau++
    const left = difference[tau - 1]!,
      center = difference[tau]!,
      right = difference[tau + 1]!
    const denominator = 2 * (2 * center - right - left)
    const correction = denominator ? (right - left) / denominator : 0
    return { frequency: rate / (tau + correction), confidence: 1 - center, rms, peak }
  }
  return empty
}
export function pitchReading(hz: number, a4: number, target?: number): { midi: number; cents: number } {
  const value = 69 + 12 * Math.log2(hz / a4)
  const midi = target ?? Math.round(value)
  return { midi, cents: 1200 * Math.log2(hz / (a4 * 2 ** ((midi - 69) / 12))) }
}
