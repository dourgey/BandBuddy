import { describe, expect, it } from 'vitest'
import { exportRequestSchema, practiceStateSchema } from '@shared/ipc.js'
import { createDefaultPracticeState } from '@shared/domain.js'

const songId = '00000000-0000-4000-8000-000000000000'

describe('IPC schemas', () => {
  it('accepts a complete six-track practice state and rejects duplicate tracks', () => {
    const state = createDefaultPracticeState(songId)
    expect(practiceStateSchema.safeParse(state).success).toBe(true)
    state.tracks[5] = { ...state.tracks[0]! }
    expect(practiceStateSchema.safeParse(state).success).toBe(false)
  })

  it('requires a complete A-B range when loop export is enabled', () => {
    const base = {
      songId, kind: 'mix', format: 'flac', stemTypes: ['vocals'], outputPath: 'C:/Exports/mix.flac',
      applyPlaybackRate: false, playbackRate: 1, applyLoopRange: true, loopStartMs: 1000,
      loopEndMs: null, overwriteMode: 'ask'
    }
    expect(exportRequestSchema.safeParse(base).success).toBe(false)
    expect(exportRequestSchema.safeParse({ ...base, loopEndMs: 2000 }).success).toBe(true)
  })

  it('accepts playback speeds from 0.2x through 4x for practice saves and mix exports', () => {
    const practice = { ...createDefaultPracticeState(songId), playbackRate: 4 }
    expect(practiceStateSchema.safeParse(practice).success).toBe(true)
    expect(practiceStateSchema.safeParse({ ...practice, playbackRate: 4.01 }).success).toBe(false)
    expect(practiceStateSchema.safeParse({ ...practice, playbackRate: 0.2 }).success).toBe(true)
    expect(practiceStateSchema.safeParse({ ...practice, playbackRate: 0.19 }).success).toBe(false)

    const request = {
      songId, kind: 'mix', format: 'mp3', stemTypes: ['vocals'], outputPath: 'C:/Exports/mix.mp3',
      applyPlaybackRate: true, playbackRate: 4, applyLoopRange: false, loopStartMs: null,
      loopEndMs: null, overwriteMode: 'ask'
    }
    expect(exportRequestSchema.safeParse(request).success).toBe(true)
    expect(exportRequestSchema.safeParse({ ...request, playbackRate: 4.01 }).success).toBe(false)
    expect(exportRequestSchema.safeParse({ ...request, playbackRate: 0.2 }).success).toBe(true)
    expect(exportRequestSchema.safeParse({ ...request, playbackRate: 0.19 }).success).toBe(false)
  })

  it('accepts metronome BPM and only supported count-in lengths', () => {
    const practice = { ...createDefaultPracticeState(songId), metronomeEnabled: true, metronomeBpm: 96.2, metronomeOffsetMs: -84, countInBeats: 8 as const }
    expect(practiceStateSchema.safeParse(practice).success).toBe(true)
    expect(practiceStateSchema.safeParse({ ...practice, metronomeBpm: 19 }).success).toBe(false)
    expect(practiceStateSchema.safeParse({ ...practice, countInBeats: 6 }).success).toBe(false)
  })
})
