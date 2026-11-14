import { describe, expect, it } from 'vitest'
import { createDefaultRecordingTrackState, type RecordingTake } from '../packages/shared/src/domain.js'
import { practiceMix, recordingMonitorGain, recordingPlaybackRate, recordingPitch, recordingPreviewUrl } from '../packages/shared/src/practice-mix.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'

describe('shared practice mixer', () => {
  it('uses track/master attenuation and M/S for live input, including a track without a take', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const track = { ...createDefaultRecordingTrackState(song.id, 'live'), gainDb: -6 }
    song.recordingTracks = [track]; song.recordingTakes = []
    song.practice.tracks.forEach(t => { t.solo = false; t.muted = false })
    song.practice.masterGainDb = -12
    expect(recordingMonitorGain(song, track.id)).toBeCloseTo(10 ** (-18 / 20))
    track.muted = true
    expect(recordingMonitorGain(song, track.id)).toBe(0)
    track.muted = false
    song.practice.tracks.find(t => t.stemType === song.stems[0]!.type)!.solo = true
    expect(recordingMonitorGain(song, track.id)).toBe(0)
    track.solo = true
    expect(recordingMonitorGain(song, track.id)).toBeCloseTo(10 ** (-18 / 20))
    expect(recordingMonitorGain(song, track.id, { ...song.practice, masterGainDb: -24 })).toBeCloseTo(10 ** (-30 / 20))
  })
  it('includes selected takes before decoding, ignores absent stems and unselected takes, and applies mute over solo', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.stems = song.stems.filter(s => s.type === 'vocals')
    song.practice.tracks.find(t => t.stemType === 'drums')!.solo = true
    const track = { ...createDefaultRecordingTrackState(song.id, 'recording'), activeTakeId: 'take', solo: true, gainDb: -6 }
    song.recordingTracks = [track]
    song.recordingTakes = [{ id: 'take' } as RecordingTake]
    expect(practiceMix(song, song.practice).gains.get('vocals')).toBe(0)
    expect(practiceMix(song, song.practice).gains.get(track.id)).toBeCloseTo(.501187)
    track.muted = true
    expect(practiceMix(song, song.practice).solo).toBe(false)
    expect(practiceMix(song, song.practice).gains.get(track.id)).toBe(0)
    expect(practiceMix(song, song.practice).gains.get('vocals')).toBeGreaterThan(0)
    track.muted = false; track.activeTakeId = 'missing'
    expect(practiceMix(song, song.practice).solo).toBe(false)
  })
  it('keeps recorded audio on the song timeline at a different speed and key', () => {
    const practice = fixtureDetail(fixtureSongs[0]!).practice
    practice.playbackRate = 1.5; practice.pitchSemitones = 7
    const take = { playbackRate: .75, pitchSemitones: -5, previewMediaUrl: 'bandbuddy-media://song/a/recording-preview/b?effects=old' } as RecordingTake
    expect(recordingPlaybackRate(take, practice)).toBe(2)
    expect(recordingPitch(take, practice)).toBe(12)
    expect(new URL(recordingPreviewUrl(take, practice)).searchParams.get('pitch')).toBe('12')
  })
})
