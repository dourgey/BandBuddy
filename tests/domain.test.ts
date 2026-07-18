import { describe, expect, it } from 'vitest'
import { createDefaultPracticeState, dbToGain, isTrackAudible } from '@shared/domain.js'

describe('track mix rules', () => {
  it('lets mute override solo and supports multiple solos', () => {
    const tracks = createDefaultPracticeState('00000000-0000-4000-8000-000000000000').tracks
    tracks[0]!.solo = true
    tracks[1]!.solo = true
    tracks[1]!.muted = true
    expect(isTrackAudible(tracks[0]!, tracks)).toBe(true)
    expect(isTrackAudible(tracks[1]!, tracks)).toBe(false)
    expect(isTrackAudible(tracks[2]!, tracks)).toBe(false)
  })

  it('converts dB to linear gain and treats the floor as silence', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(6)).toBeCloseTo(1.995262, 5)
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 5)
    expect(dbToGain(-60)).toBe(0)
  })
})
