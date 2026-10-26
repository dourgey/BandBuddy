import type { StringPitch } from './poly-pitch.js'

/** Require independent, strong string evidence; harmonics of one string must not switch views. */
export function hasStrongPolyEvidence(strings: Array<StringPitch | null>, monoConfidence: number): boolean {
  const strong = strings.filter((value): value is StringPitch => Boolean(value && value.confidence >= 0.65))
  if (monoConfidence >= 0.96 || strong.length < 2) return false
  return strong.length >= 3 || strong.every(value => value.confidence >= 0.8)
}

export function createTunerModeGate(): { update(candidate: 'mono' | 'poly' | null, now: number): 'mono' | 'poly' } {
  let mode: 'mono' | 'poly' = 'mono', pending: 'mono' | 'poly' | null = null, since = 0, last = -Infinity
  return { update(candidate, now) {
    // A paused analyser cannot count wall time as continuous evidence.
    if (now - last > 250) pending = null
    last = now
    if (!candidate || candidate === mode) pending = null
    else if (pending !== candidate) { pending = candidate; since = now }
    else if (now - since > 500) { mode = candidate; pending = null }
    return mode
  } }
}
