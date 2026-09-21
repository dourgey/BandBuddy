import { describe, expect, it } from 'vitest'
import { createDefaultPracticeState } from '../packages/shared/src/domain.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { patchTrackStates, usePlayerStore } from '../src/renderer/src/player-store.js'
import { hasEffectiveSolo, isImpliedMuted } from '../src/renderer/src/utils.js'

describe('practice track button rules', () => {
  it('keeps Solo exclusive and prevents a track from being both muted and soloed', () => {
    let tracks = createDefaultPracticeState('song').tracks
    tracks = patchTrackStates(tracks, 'drums', { solo: true })
    tracks = patchTrackStates(tracks, 'vocals', { solo: true })

    expect(tracks.filter((track) => track.solo).map((track) => track.stemType)).toEqual(['vocals'])
    tracks = patchTrackStates(tracks, 'vocals', { muted: true })
    expect(tracks.find((track) => track.stemType === 'vocals')).toMatchObject({ muted: true, solo: false })

    tracks = patchTrackStates(tracks, 'vocals', { solo: true })
    expect(tracks.find((track) => track.stemType === 'vocals')).toMatchObject({ muted: false, solo: true })
  })

  it('preserves the hidden guitar mode mix state while editing the visible mode', () => {
    let tracks = createDefaultPracticeState('song').tracks.map((track) => (
      track.stemType === 'guitar' ? { ...track, gainDb: -7, solo: true, outputChannelPair: 5 } : track
    ))
    tracks = patchTrackStates(tracks, 'lead_guitar', { solo: true, gainDb: 3 }, true)
    expect(tracks.find((track) => track.stemType === 'guitar')).toMatchObject({ gainDb: -7, solo: true, outputChannelPair: 5 })
    expect(tracks.find((track) => track.stemType === 'lead_guitar')).toMatchObject({ gainDb: 3, solo: true })
  })

  it('moves selection between guitar modes without rewriting any track state', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.selectedStem = 'guitar'
    song.practice.tracks = song.practice.tracks.map((track) => ({
      ...track,
      gainDb: track.stemType === 'rhythm_guitar' ? -4 : track.gainDb,
      muted: track.stemType === 'acoustic_guitar',
      outputChannelPair: track.stemType === 'lead_guitar' ? 7 : track.outputChannelPair
    }))
    usePlayerStore.getState().loadSong(song)
    const before = structuredClone(usePlayerStore.getState().practice!.tracks)
    usePlayerStore.getState().patchPractice({ guitarSplitEnabled: true })
    expect(usePlayerStore.getState().selectedStem).toBe('acoustic_guitar')
    expect(usePlayerStore.getState().practice!.tracks).toEqual(before)
    usePlayerStore.getState().patchPractice({ guitarSplitEnabled: false })
    expect(usePlayerStore.getState().selectedStem).toBe('guitar')
    expect(usePlayerStore.getState().practice!.tracks).toEqual(before)
    usePlayerStore.getState().unload()
  })

  it('keeps imported guitar tracks independently selectable and soloable', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.sourceFormat = 'existing-stems'
    song.practice.selectedStem = 'lead_guitar'
    usePlayerStore.getState().loadSong(song)
    usePlayerStore.getState().patchPractice({ loopStartMs: 1000 })
    expect(usePlayerStore.getState().selectedStem).toBe('lead_guitar')
    usePlayerStore.getState().patchTrack('lead_guitar', { solo: true })
    usePlayerStore.getState().patchTrack('guitar', { solo: true })
    expect(usePlayerStore.getState().practice!.tracks.filter((track) => track.solo).map((track) => track.stemType)).toEqual(['guitar'])
    usePlayerStore.getState().unload()
  })

  it('uses the editable song BPM as the metronome value when loading a song', () => {
    const song = fixtureDetail(fixtureSongs[1]!)
    song.practice.metronomeBpm = 120
    song.practice.metronomeOffsetMs = 0
    song.beatOffsetMs = -86
    expect(song.bpm).toBe(74)

    usePlayerStore.getState().loadSong(song)
    expect(usePlayerStore.getState().practice?.metronomeBpm).toBe(74)
    expect(usePlayerStore.getState().practice?.metronomeOffsetMs).toBe(-86)
    usePlayerStore.getState().unload()
  })

  it.each([
    [-24, -12], [24, 12], [-3.8, -4], [2.2, 2], [NaN, 0], [Infinity, 0]
  ])('normalizes a saved or edited pitch of %s before playback and autosave', (input, expected) => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.pitchSemitones = input
    usePlayerStore.getState().loadSong(song)
    expect(usePlayerStore.getState().practice?.pitchSemitones).toBe(expected)
    usePlayerStore.getState().patchPractice({ pitchSemitones: 0 })
    usePlayerStore.getState().patchPractice({ pitchSemitones: input })
    expect(usePlayerStore.getState().practice?.pitchSemitones).toBe(expected)
    usePlayerStore.getState().unload()
  })
})

describe('implied mute', () => {
  it('counts only visible, unmuted solos plus the recording override', () => {
    const tracks = createDefaultPracticeState('song').tracks
    expect(hasEffectiveSolo(tracks, false)).toBe(false)
    expect(hasEffectiveSolo(tracks, false, true)).toBe(true)

    // A soloed guitar alternative is hidden in non-guitar mode, so it silences nothing.
    tracks.find((track) => track.stemType === 'acoustic_guitar')!.solo = true
    expect(hasEffectiveSolo(tracks, false)).toBe(false)
    expect(hasEffectiveSolo(tracks, true)).toBe(true)

    // Muting the soloed track takes it back out of the solo set.
    tracks.find((track) => track.stemType === 'acoustic_guitar')!.muted = true
    expect(hasEffectiveSolo(tracks, true)).toBe(false)
  })

  it('marks only tracks that are neither muted nor soloed', () => {
    expect(isImpliedMuted({ muted: false, solo: false }, true)).toBe(true)
    expect(isImpliedMuted({ muted: true, solo: false }, true)).toBe(false)
    expect(isImpliedMuted({ muted: false, solo: true }, true)).toBe(false)
    expect(isImpliedMuted({ muted: false, solo: false }, false)).toBe(false)
  })
})
