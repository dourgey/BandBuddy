import { describe, expect, it } from 'vitest'
import {
  desktopLyricsPayloadSchema,
  exportRequestSchema,
  practiceStateSchema,
  rehearsalRecordingStartSchema,
  rehearsalSaveSchema
} from '@shared/ipc.js'
import { createDefaultPracticeState } from '@shared/domain.js'

const songId = '00000000-0000-4000-8000-000000000000'

describe('IPC schemas', () => {
  it('accepts a complete six-track practice state and rejects duplicate tracks', () => {
    const state = createDefaultPracticeState(songId)
    expect(practiceStateSchema.safeParse(state).success).toBe(true)
    state.tracks[5] = { ...state.tracks[0]! }
    expect(practiceStateSchema.safeParse(state).success).toBe(false)
  })

  it('requires a unique visual order containing every separated stem', () => {
    const state = createDefaultPracticeState(songId)
    expect(practiceStateSchema.safeParse({ ...state, trackOrder: [...state.trackOrder, state.trackOrder[0]] }).success).toBe(false)
    expect(practiceStateSchema.safeParse({ ...state, trackOrder: state.trackOrder.slice(1) }).success).toBe(false)
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

  it('bounds desktop lyric updates sent to the overlay window', () => {
    const payload = {
      title: 'Song',
      artist: 'Artist',
      currentLines: ['当前句'],
      nextLines: ['下一句'],
      progress: 0.5,
      playing: true
    }
    expect(desktopLyricsPayloadSchema.safeParse(payload).success).toBe(true)
    expect(desktopLyricsPayloadSchema.safeParse({ ...payload, progress: 1.01 }).success).toBe(false)
    expect(desktopLyricsPayloadSchema.safeParse({ ...payload, currentLines: Array(5).fill('line') }).success).toBe(false)
  })

  it('validates rehearsal queue identity, transition bounds and recording position', () => {
    const rehearsalId = '10000000-0000-4000-8000-000000000000'
    const transition = {
      id: '20000000-0000-4000-8000-000000000000',
      kind: 'transition' as const,
      durationMs: 10_000
    }
    const request = { id: rehearsalId, name: '周末排练', items: [transition] }
    expect(rehearsalSaveSchema.safeParse(request).success).toBe(true)
    expect(rehearsalSaveSchema.safeParse({ ...request, items: [transition, transition] }).success).toBe(false)
    expect(rehearsalSaveSchema.safeParse({
      ...request,
      items: [{ ...transition, durationMs: 999 }]
    }).success).toBe(false)
    expect(rehearsalSaveSchema.safeParse({
      ...request,
      items: [{ ...transition, durationMs: 3_601_000 }]
    }).success).toBe(false)
    expect(rehearsalRecordingStartSchema.safeParse({
      rehearsalId,
      recordingTrackId: '30000000-0000-4000-8000-000000000000',
      positionMs: 12_500
    }).success).toBe(true)
    expect(rehearsalRecordingStartSchema.safeParse({
      rehearsalId,
      recordingTrackId: '30000000-0000-4000-8000-000000000000',
      positionMs: -1
    }).success).toBe(false)
  })
})
