/** Media timestamps are observations, not sample-accurate audio clocks. */
export interface MediaClock {
  checkedAt: number
  drift: number
  largeDriftSince: number | null
  resyncAfter: number
}

export function createMediaClock(now: number): MediaClock {
  return { checkedAt: now, drift: 0, largeDriftSince: null, resyncAfter: now + .5 }
}

/** Drift is in real seconds (including the nominal playback/recording rate). */
export function followMediaClock(clock: MediaClock, drift: number, now: number): boolean {
  if (!Number.isFinite(drift) || !Number.isFinite(now)) return false
  const elapsed = now - clock.checkedAt
  if (elapsed < .05) return false
  clock.checkedAt = now
  // Forget stale observations after a long stall, while still allowing clock
  // recovery in background windows whose animation frames arrive at 1 Hz.
  if (elapsed > 2.5) { clock.drift = 0; clock.largeDriftSince = null }
  clock.drift += (drift - clock.drift) * (1 - Math.exp(-Math.min(elapsed, .1) / .3))
  if (Math.abs(drift) > .06 && Math.abs(clock.drift) > .06 && Math.sign(drift) === Math.sign(clock.drift)) {
    clock.largeDriftSince ??= now
    if (now >= clock.resyncAfter && now - clock.largeDriftSince >= .5) {
      clock.drift = 0; clock.largeDriftSince = null
      clock.resyncAfter = now + 2
      return true
    }
  } else clock.largeDriftSince = null
  // Changing playbackRate to chase small timestamp errors repeatedly switches
  // Chromium's time stretcher on/off at 1x, which can itself produce clicks.
  return false
}
