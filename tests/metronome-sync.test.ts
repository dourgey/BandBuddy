import { describe, expect, it } from 'vitest'
import { createDefaultPracticeState, normalizeBeatOffsetMs, type RecordingTake } from '@shared/domain.js'
import {
  nextMetronomeBeat,
  TAKE_PREVIEW_PLAYBACK_RATE,
  takePreviewTimeSeconds
} from '../src/renderer/src/audio-engine.js'
import { recordingPlaybackRate, recordingPitch } from '../packages/shared/src/practice-mix.js'

describe('metronome song-grid synchronization', () => {
  it('schedules the next click from song position and detected phase', () => {
    expect(nextMetronomeBeat(875, 120, 125, 1)).toEqual({
      beatIndex: 2,
      delaySeconds: 0.25,
      intervalSeconds: 0.5
    })
  })

  it('scales both delay and interval with playback speed', () => {
    expect(nextMetronomeBeat(875, 120, 125, 0.5)).toEqual({
      beatIndex: 2,
      delaySeconds: 0.5,
      intervalSeconds: 1
    })
  })

  it('skips a beat that is too late to schedule and wraps equivalent offsets', () => {
    expect(nextMetronomeBeat(1125, 120, 125, 1)).toMatchObject({ beatIndex: 3, delaySeconds: 0.5 })
    expect(normalizeBeatOffsetMs(325, 120)).toBe(-175)
  })
})

describe('recording preview synchronization', () => {
  it('maps the song timeline into recording time while the preview itself advances at real time', () => {
    expect(takePreviewTimeSeconds(12_000, 0.5)).toBe(24)
    expect(TAKE_PREVIEW_PLAYBACK_RATE).toBe(1)
  })

  it('adapts a selected take to current speed and pitch instead of silently excluding it', () => {
    const practice = createDefaultPracticeState('00000000-0000-4000-8000-000000000000')
    practice.playbackRate = 0.8
    practice.pitchSemitones = 3
    const take = { playbackRate: 0.8, pitchSemitones: 3 } as RecordingTake
    expect(recordingPlaybackRate(take, practice)).toBe(1)
    expect(recordingPitch({ ...take, pitchSemitones: 2 }, practice)).toBe(1)
    expect(recordingPlaybackRate({ ...take, playbackRate: 1 }, practice)).toBe(.8)
  })
})
