export interface BpmAnalysis {
  bpm: number
  confidence: number
  /** Position of the beat grid relative to the start of the song. */
  beatOffsetMs: number
}

interface Peak {
  frame: number
  strength: number
}

interface GridFit {
  phaseFrames: number
  coverage: number
  occupancy: number
  score: number
}

interface TempoCandidate {
  lag: number
  bpm: number
  autocorrelation: number
  intervalScore: number
  grid: GridFit
  score: number
}

const MIN_BPM = 45
const MAX_BPM = 240
const TARGET_ENVELOPE_RATE = 100

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

function percentile(values: Float64Array, fraction: number): number {
  const sorted = Array.from(values).filter((value) => value > 0).sort((left, right) => left - right)
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0
}

/**
 * Builds a multi-band onset-strength envelope. Energy changes are measured in
 * four inexpensive filter bands, which is substantially more resistant to
 * sustained notes and loudness changes than a broadband RMS envelope.
 */
function buildOnsetEnvelope(samples: Float32Array, sampleRate: number): { values: Float64Array; framesPerSecond: number } | null {
  const hopSize = Math.max(16, Math.round(sampleRate / TARGET_ENVELOPE_RATE))
  const frameCount = Math.floor(samples.length / hopSize)
  if (frameCount < TARGET_ENVELOPE_RATE * 4) return null

  const bandEnergy = Array.from({ length: 4 }, () => new Float64Array(frameCount))
  const cutoff = (frequency: number): number => 1 - Math.exp(-2 * Math.PI * Math.min(frequency, sampleRate * 0.42) / sampleRate)
  const lowCoefficient = cutoff(160)
  const middleCoefficient = cutoff(700)
  const highCoefficient = cutoff(2500)
  const dcCoefficient = Math.exp(-2 * Math.PI * 25 / sampleRate)
  let previousSample = 0
  let previousHighPass = 0
  let lowPass = 0
  let middlePass = 0
  let highPass = 0
  let peakEnergy = 0

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sums = [0, 0, 0, 0]
    const start = frame * hopSize
    for (let offset = 0; offset < hopSize; offset += 1) {
      const input = samples[start + offset] ?? 0
      const dcBlocked = input - previousSample + dcCoefficient * previousHighPass
      previousSample = input
      previousHighPass = dcBlocked
      lowPass += lowCoefficient * (dcBlocked - lowPass)
      middlePass += middleCoefficient * (dcBlocked - middlePass)
      highPass += highCoefficient * (dcBlocked - highPass)
      const bands = [lowPass, middlePass - lowPass, highPass - middlePass, dcBlocked - highPass]
      for (let band = 0; band < bands.length; band += 1) sums[band]! += bands[band]! * bands[band]!
    }
    for (let band = 0; band < sums.length; band += 1) {
      const energy = sums[band]! / hopSize
      bandEnergy[band]![frame] = energy
      if (energy > peakEnergy) peakEnergy = energy
    }
  }
  if (peakEnergy < 1e-10) return null

  const rawFlux = new Float64Array(frameCount)
  const weights = [0.85, 1, 1.05, 1.15]
  for (let frame = 1; frame < frameCount; frame += 1) {
    let flux = 0
    for (let band = 0; band < bandEnergy.length; band += 1) {
      const current = Math.log(bandEnergy[band]![frame]! + peakEnergy * 1e-7 + 1e-14)
      const previous = Math.log(bandEnergy[band]![frame - 1]! + peakEnergy * 1e-7 + 1e-14)
      flux += weights[band]! * Math.max(0, current - previous)
    }
    rawFlux[frame] = flux
  }

  const prefix = new Float64Array(frameCount + 1)
  const prefixSquares = new Float64Array(frameCount + 1)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const value = rawFlux[frame]!
    prefix[frame + 1] = prefix[frame]! + value
    prefixSquares[frame + 1] = prefixSquares[frame]! + value * value
  }

  const adaptive = new Float64Array(frameCount)
  const radius = Math.max(8, Math.round((sampleRate / hopSize) * 0.45))
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = Math.max(0, frame - radius)
    const end = Math.min(frameCount, frame + radius + 1)
    const count = end - start
    const mean = (prefix[end]! - prefix[start]!) / count
    const meanSquare = (prefixSquares[end]! - prefixSquares[start]!) / count
    const deviation = Math.sqrt(Math.max(0, meanSquare - mean * mean))
    adaptive[frame] = Math.max(0, rawFlux[frame]! - mean * 0.72 - deviation * 0.08)
  }

  // A single very loud transient should not determine the tempo of a whole song.
  const ceiling = percentile(adaptive, 0.975)
  if (ceiling <= 1e-8) return null
  let energy = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    let value = Math.min(adaptive[frame]!, ceiling)
    const left = adaptive[Math.max(0, frame - 1)] ?? 0
    const right = adaptive[Math.min(frameCount - 1, frame + 1)] ?? 0
    if (value < left || value < right) value *= 0.35
    adaptive[frame] = value
    energy += value * value
  }
  if (energy < 1e-8) return null

  const scale = Math.sqrt(energy / frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) adaptive[frame] = adaptive[frame]! / scale
  return { values: adaptive, framesPerSecond: sampleRate / hopSize }
}

function centeredCorrelation(values: Float64Array, lag: number): number {
  if (lag <= 0 || lag >= values.length - 2) return 0
  let leftMean = 0
  let rightMean = 0
  const count = values.length - lag
  for (let index = lag; index < values.length; index += 1) {
    leftMean += values[index]!
    rightMean += values[index - lag]!
  }
  leftMean /= count
  rightMean /= count

  let product = 0
  let leftEnergy = 0
  let rightEnergy = 0
  for (let index = lag; index < values.length; index += 1) {
    const left = values[index]! - leftMean
    const right = values[index - lag]! - rightMean
    product += left * right
    leftEnergy += left * left
    rightEnergy += right * right
  }
  const scale = Math.sqrt(leftEnergy * rightEnergy)
  return scale > 1e-9 ? product / scale : 0
}

function pickPeaks(values: Float64Array, framesPerSecond: number): Peak[] {
  let mean = 0
  let meanSquare = 0
  for (const value of values) {
    mean += value
    meanSquare += value * value
  }
  mean /= values.length
  const deviation = Math.sqrt(Math.max(0, meanSquare / values.length - mean * mean))
  const threshold = mean + deviation * 0.18
  const radius = Math.max(1, Math.round(framesPerSecond * 0.025))
  const minimumDistance = Math.max(1, Math.round(framesPerSecond * 0.035))
  const peaks: Peak[] = []

  for (let frame = radius; frame < values.length - radius; frame += 1) {
    const strength = values[frame]!
    if (strength < threshold) continue
    let maximum = true
    for (let offset = 1; offset <= radius; offset += 1) {
      if (values[frame - offset]! > strength || values[frame + offset]! >= strength) {
        maximum = false
        break
      }
    }
    if (!maximum) continue
    const previous = peaks.at(-1)
    if (previous && frame - previous.frame < minimumDistance) {
      if (strength > previous.strength) peaks[peaks.length - 1] = { frame, strength }
    } else peaks.push({ frame, strength })
  }
  return peaks
}

function intervalEvidence(peaks: readonly Peak[], lag: number): number {
  let score = 0
  for (let left = 0; left < peaks.length; left += 1) {
    const first = peaks[left]!
    for (let right = left + 1; right < Math.min(peaks.length, left + 9); right += 1) {
      const second = peaks[right]!
      const distance = second.frame - first.frame
      const multiple = Math.round(distance / lag)
      if (multiple < 1) continue
      if (multiple > 4) break
      const tolerance = Math.max(1.25, lag * 0.045 * Math.sqrt(multiple))
      const deviation = Math.abs(distance - multiple * lag)
      if (deviation > tolerance * 3) continue
      const match = Math.exp(-0.5 * (deviation / tolerance) ** 2)
      score += Math.sqrt(first.strength * second.strength) * match / multiple
    }
  }
  return score
}

function evaluateGrid(values: Float64Array, peaks: readonly Peak[], lag: number, framesPerSecond: number): GridFit {
  const bins = Math.max(16, Math.round(lag * 4))
  const folded = new Float64Array(bins)
  let totalStrength = 0
  for (const peak of peaks) {
    const position = positiveModulo(peak.frame + 0.5, lag) / lag * bins
    const lower = Math.floor(position) % bins
    const fraction = position - Math.floor(position)
    folded[lower] = folded[lower]! + peak.strength * (1 - fraction)
    const upper = (lower + 1) % bins
    folded[upper] = folded[upper]! + peak.strength * fraction
    totalStrength += peak.strength
  }

  const smoothingRadius = Math.max(2, Math.round(framesPerSecond * 0.03 / lag * bins))
  let bestBin = 0
  let bestStrength = 0
  for (let bin = 0; bin < bins; bin += 1) {
    let strength = 0
    let weightTotal = 0
    for (let offset = -smoothingRadius; offset <= smoothingRadius; offset += 1) {
      const weight = Math.exp(-0.5 * (offset / Math.max(1, smoothingRadius * 0.48)) ** 2)
      strength += folded[positiveModulo(bin + offset, bins)]! * weight
      weightTotal += weight
    }
    strength /= weightTotal
    if (strength > bestStrength) {
      bestStrength = strength
      bestBin = bin
    }
  }

  const phaseFrames = bestBin / bins * lag
  const phaseTolerance = Math.max(1, Math.round(framesPerSecond * 0.035))
  let alignedStrength = 0
  for (const peak of peaks) {
    const phaseDistance = Math.abs(positiveModulo(peak.frame + 0.5 - phaseFrames + lag / 2, lag) - lag / 2)
    if (phaseDistance <= phaseTolerance) {
      alignedStrength += peak.strength * Math.exp(-0.5 * (phaseDistance / Math.max(1, phaseTolerance * 0.6)) ** 2)
    }
  }
  const coverage = totalStrength > 1e-9 ? clamp(alignedStrength / totalStrength, 0, 1) : 0

  let hitSum = 0
  let hitSquares = 0
  let beatCount = 0
  let beat = phaseFrames
  while (beat - lag >= 0) beat -= lag
  while (beat < 0) beat += lag
  for (; beat < values.length; beat += lag) {
    const center = Math.round(beat - 0.5)
    let hit = 0
    for (let offset = -phaseTolerance; offset <= phaseTolerance; offset += 1) {
      const frame = center + offset
      if (frame >= 0 && frame < values.length) hit = Math.max(hit, values[frame] ?? 0)
    }
    hitSum += hit
    hitSquares += hit * hit
    beatCount += 1
  }
  const occupancy = beatCount > 0 && hitSquares > 1e-9 ? clamp(hitSum * hitSum / (beatCount * hitSquares), 0, 1) : 0
  return { phaseFrames, coverage, occupancy, score: Math.sqrt(coverage * occupancy) }
}

function tempoPrior(bpm: number): number {
  if (bpm >= 65 && bpm <= 190) return 1
  if (bpm < 65) return 0.82 + 0.18 * clamp((bpm - MIN_BPM) / (65 - MIN_BPM), 0, 1)
  return 1 - 0.14 * clamp((bpm - 190) / (MAX_BPM - 190), 0, 1)
}

function refineBeatGrid(peaks: readonly Peak[], initialPeriod: number, initialPhase: number): { period: number; phase: number } {
  let period = initialPeriod
  let phase = initialPhase
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const tolerance = Math.max(2, Math.min(7, period * 0.12))
    let weightSum = 0
    let beatSum = 0
    let timeSum = 0
    let beatSquareSum = 0
    let beatTimeSum = 0
    for (const peak of peaks) {
      const time = peak.frame + 0.5
      const beat = Math.round((time - phase) / period)
      const residual = time - (phase + beat * period)
      if (Math.abs(residual) > tolerance) continue
      const robust = (1 - (residual / tolerance) ** 2) ** 2
      const weight = Math.sqrt(peak.strength) * robust
      weightSum += weight
      beatSum += weight * beat
      timeSum += weight * time
      beatSquareSum += weight * beat * beat
      beatTimeSum += weight * beat * time
    }
    const denominator = beatSquareSum - beatSum * beatSum / Math.max(weightSum, 1e-9)
    if (weightSum < 4 || denominator < 1e-6) break
    const nextPeriod = (beatTimeSum - beatSum * timeSum / weightSum) / denominator
    if (!Number.isFinite(nextPeriod) || Math.abs(nextPeriod / initialPeriod - 1) > 0.06) break
    period = nextPeriod
    phase = (timeSum - period * beatSum) / weightSum
  }
  return { period, phase }
}

export function detectBpmFromSamples(samples: Float32Array, sampleRate: number): BpmAnalysis | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length < sampleRate * 4) return null
  const envelope = buildOnsetEnvelope(samples, sampleRate)
  if (!envelope) return null
  const { values, framesPerSecond } = envelope
  const peaks = pickPeaks(values, framesPerSecond)
  if (peaks.length < 8) return null

  const minimumLag = Math.max(2, Math.floor(framesPerSecond * 60 / MAX_BPM))
  const maximumLag = Math.min(values.length - 2, Math.ceil(framesPerSecond * 60 / MIN_BPM))
  const correlationCache = new Float64Array(Math.min(values.length - 2, maximumLag * 3) + 1)
  for (let lag = 1; lag < correlationCache.length; lag += 1) correlationCache[lag] = centeredCorrelation(values, lag)

  const candidates: TempoCandidate[] = []
  let maximumIntervalScore = 0
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const primary = Math.max(0, correlationCache[lag] ?? 0)
    const double = Math.max(0, correlationCache[lag * 2] ?? 0)
    const triple = Math.max(0, correlationCache[lag * 3] ?? 0)
    const half = Math.max(0, correlationCache[Math.round(lag / 2)] ?? 0)
    const autocorrelation = clamp((primary + double * 0.5 + triple * 0.2 - half * 0.08) / 1.7, 0, 1)
    const intervalScore = intervalEvidence(peaks, lag)
    maximumIntervalScore = Math.max(maximumIntervalScore, intervalScore)
    candidates.push({
      lag,
      bpm: 60 * framesPerSecond / lag,
      autocorrelation,
      intervalScore,
      grid: evaluateGrid(values, peaks, lag, framesPerSecond),
      score: 0
    })
  }
  if (maximumIntervalScore <= 1e-9) return null

  for (const candidate of candidates) {
    candidate.intervalScore = clamp(candidate.intervalScore / maximumIntervalScore, 0, 1)
    candidate.score = (
      candidate.autocorrelation * 0.4
      + candidate.intervalScore * 0.32
      + candidate.grid.score * 0.28
    ) * tempoPrior(candidate.bpm)
  }
  candidates.sort((left, right) => right.score - left.score)
  let best = candidates[0]
  // A strong/weak backbeat often produces an excellent half-tempo correlation.
  // Prefer the intervening pulse when the onset intervals independently support it.
  if (best && best.bpm < 70) {
    const doubled = candidates
      .filter((candidate) => Math.abs(candidate.bpm / best!.bpm - 2) < 0.045)
      .sort((left, right) => right.score - left.score)[0]
    if (doubled && doubled.score >= best.score * 0.64 && doubled.intervalScore >= best.intervalScore * 0.97) best = doubled
  }
  if (!best || best.score < 0.16 || best.autocorrelation < 0.035 || best.grid.score < 0.16) return null

  const refined = refineBeatGrid(peaks, best.lag, best.grid.phaseFrames)
  const rawBpm = 60 * framesPerSecond / refined.period
  if (!Number.isFinite(rawBpm) || rawBpm < MIN_BPM || rawBpm > MAX_BPM) return null
  const bpm = Math.round(rawBpm * 10) / 10
  const beatDurationMs = 60_000 / bpm
  let beatOffsetMs = positiveModulo(refined.phase / framesPerSecond * 1000 + beatDurationMs / 2, beatDurationMs) - beatDurationMs / 2
  beatOffsetMs = Math.round(beatOffsetMs)
  if (Object.is(beatOffsetMs, -0)) beatOffsetMs = 0

  const distinctRunnerUp = candidates.find((candidate) => Math.abs(candidate.bpm - best.bpm) / best.bpm > 0.025)
  const margin = distinctRunnerUp ? clamp((best.score - distinctRunnerUp.score) / Math.max(best.score, 1e-9), 0, 1) : 1
  const quality = best.autocorrelation * 0.46 + best.grid.score * 0.34 + best.intervalScore * 0.2
  const confidence = clamp((quality - 0.05) / 0.72 * 0.88 + margin * 0.12, 0, 1)
  return { bpm, confidence, beatOffsetMs }
}
