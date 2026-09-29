export interface StringPitch {
  midi: number
  hz: number
  cents: number
  confidence: number
}

/** A conservative, tuning-constrained spectral check. Uncertain strings stay empty. */
export function detectPolyStrings(samples: Float32Array, sampleRate: number, notes: number[], a4: number): Array<StringPitch | null> {
  const size = 1 << Math.floor(Math.log2(samples.length))
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  let mean = 0
  for (let i = 0; i < size; i++) mean += samples[i]!
  mean /= size
  for (let i = 0; i < size; i++) real[i] = (samples[i]! - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)))
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const x = real[i]!
      real[i] = real[j]!
      real[j] = x
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const half = length >> 1
    for (let start = 0; start < size; start += length) {
      for (let offset = 0; offset < half; offset++) {
        const angle = (-2 * Math.PI * offset) / length
        const cos = Math.cos(angle), sin = Math.sin(angle)
        const right = start + offset + half, left = start + offset
        const r = real[right]! * cos - imaginary[right]! * sin
        const im = real[right]! * sin + imaginary[right]! * cos
        real[right] = real[left]! - r
        imaginary[right] = imaginary[left]! - im
        real[left] = real[left]! + r
        imaginary[left] = imaginary[left]! + im
      }
    }
  }
  const magnitude = new Float64Array(size / 2)
  let maximum = 0
  for (let i = 1; i < magnitude.length; i++) {
    magnitude[i] = Math.hypot(real[i]!, imaginary[i]!)
    maximum = Math.max(maximum, magnitude[i]!)
  }
  if (maximum < 0.01) return notes.map(() => null)
  const binWidth = sampleRate / size
  const peakAt = (frequency: number): { value: number; hz: number } => {
    const center = Math.round(frequency / binWidth)
    let best = center
    for (let bin = Math.max(1, center - 1); bin <= Math.min(magnitude.length - 2, center + 1); bin++)
      if (magnitude[bin]! > magnitude[best]!) best = bin
    const left = magnitude[best - 1]!, middle = magnitude[best]!, right = magnitude[best + 1]!
    const denominator = left - 2 * middle + right
    const shift = denominator ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * denominator))) : 0
    return { value: middle, hz: (best + shift) * binWidth }
  }
  const candidates = notes.map((midi) => {
    const target = a4 * 2 ** ((midi - 69) / 12)
    let bestScore = 0, bestCents = 0, bestEvidence = 0
    for (let cents = -100; cents <= 100; cents += 2) {
      const fundamental = target * 2 ** (cents / 1200)
      let score = 0, evidence = 0
      for (let harmonic = 1; harmonic <= 8; harmonic++) {
        const frequency = fundamental * harmonic
        if (frequency >= sampleRate / 2) break
        const peak = peakAt(frequency)
        const distance = Math.abs(1200 * Math.log2(peak.hz / frequency))
        const weight = 1 / harmonic ** 0.8
        const value = distance < Math.max(8, (binWidth / frequency) * 600) ? peak.value / maximum : 0
        score += value * weight
        if (value > 0.08) evidence++
      }
      if (score > bestScore) { bestScore = score; bestCents = cents; bestEvidence = evidence }
    }
    const estimates: Array<{ cents: number; weight: number }> = []
    for (let harmonic = 2; harmonic <= 8; harmonic++) {
      const peak = peakAt(target * 2 ** (bestCents / 1200) * harmonic)
      const cents = 1200 * Math.log2(peak.hz / (target * harmonic))
      if (Math.abs(cents - bestCents) <= 30 && peak.value / maximum > 0.08)
        estimates.push({ cents, weight: peak.value / harmonic ** 0.8 })
    }
    estimates.sort((a, b) => a.cents - b.cents)
    const totalWeight = estimates.reduce((sum, estimate) => sum + estimate.weight, 0)
    let cumulative = 0
    for (const estimate of estimates) {
      cumulative += estimate.weight
      if (cumulative >= totalWeight / 2) { bestCents = estimate.cents; break }
    }
    const hz = target * 2 ** (bestCents / 1200)
    const fundamental = peakAt(hz).value / maximum
    return { midi, hz, cents: bestCents, score: bestScore, evidence: bestEvidence, fundamental }
  })
  const strongest = Math.max(...candidates.map((candidate) => candidate.score))
  return candidates.map((candidate, index) => {
    const lowerExplains = candidates.some((other, otherIndex) => {
      if (otherIndex === index || other.hz >= candidate.hz || other.score <= candidate.score * 1.1) return false
      const ratio = candidate.hz / other.hz
      return Math.abs(ratio - Math.round(ratio)) < 0.025 && candidate.fundamental < other.fundamental * 0.7
    })
    if (lowerExplains || candidate.evidence < 2 || candidate.fundamental < 0.09 || candidate.score < Math.max(0.22, strongest * 0.22)) return null
    return { midi: candidate.midi, hz: candidate.hz, cents: candidate.cents, confidence: Math.min(1, candidate.score / strongest) }
  })
}
