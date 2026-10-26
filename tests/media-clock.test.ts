import { describe, expect, it } from 'vitest'
import { createMediaClock, followMediaClock } from '../src/renderer/src/media-clock.js'

describe('media timestamp observations', () => {
  it('ignores frame jitter and isolated timestamp spikes, including renderer stalls', () => {
    const clock = createMediaClock(0)
    let now = 0
    for (let frame = 0; frame < 600; frame++) {
      now += frame % 19 === 0 ? .15 : 1 / 60
      const drift = frame % 90 === 0 ? .4 : Math.floor(now / .08) % 2 ? .045 : -.045
      expect(followMediaClock(clock, drift, now)).toBe(false)
    }
  })

  it.each([.25, -.25])('recovers sustained drift %s once, then waits before retrying', drift => {
    const clock = createMediaClock(0), recovered: number[] = []
    for (let sample = 1; sample < 80; sample++) {
      const now = sample * .1
      if (followMediaClock(clock, drift, now)) recovered.push(now)
    }
    expect(recovered[0]).toBeGreaterThanOrEqual(.5)
    expect(recovered[0]).toBeLessThan(1.5)
    for (let index = 1; index < recovered.length; index++) expect(recovered[index]! - recovered[index - 1]!).toBeGreaterThanOrEqual(2)
  })

  it('does not treat a long renderer stall as evidence of persistent drift', () => {
    const clock = createMediaClock(0)
    for (const now of [.1, .2, .3, .4, .5, 4]) expect(followMediaClock(clock, .25, now)).toBe(false)
    for (const now of [4.1, 4.2, 4.3, 4.4]) expect(followMediaClock(clock, 0, now)).toBe(false)
  })

  it('can recover at the reduced animation rate of a background window', () => {
    const clock = createMediaClock(0)
    expect([1, 2, 3].some(now => followMediaClock(clock, .25, now))).toBe(true)
  })

  it('rejects invalid timestamps without poisoning later observations', () => {
    const clock = createMediaClock(0)
    for (const [drift, now] of [[NaN, 1], [0, Infinity], [Infinity, 2], [0, -1]]) expect(followMediaClock(clock, drift!, now!)).toBe(false)
    expect(followMediaClock(clock, 0, 1)).toBe(false)
    expect(Number.isFinite(clock.drift)).toBe(true)
  })
})
