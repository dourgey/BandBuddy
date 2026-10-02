import { create } from 'zustand'
import { createDefaultPracticeState, isStemVisible, normalizePitchSemitones, normalizeSelectedStemForGuitarMode, type RecordingMeter, type PracticeState, type SongDetail, type StemType, type TrackState } from '@shared/domain.js'

export function patchTrackStates(
  tracks: readonly TrackState[],
  stemType: StemType,
  patch: Partial<TrackState>,
  guitarSplitEnabled = false,
  importedStems = false
): TrackState[] {
  const enablesSolo = patch.solo === true
  return tracks.map((track) => {
    if (track.stemType !== stemType) {
      return enablesSolo && track.solo && (importedStems || isStemVisible(track.stemType, guitarSplitEnabled))
        ? { ...track, solo: false }
        : track
    }
    const next = { ...track, ...patch }
    if (patch.solo === true) next.muted = false
    if (patch.muted === true) next.solo = false
    return next
  })
}

interface PlayerStore {
  song: SongDetail | null
  practice: PracticeState | null
  currentMs: number
  playing: boolean
  selectedStem: StemType
  loadSong(song: SongDetail): void
  updateSongDetails(song: SongDetail): void
  unload(): void
  setPlaying(playing: boolean): void
  setCurrentMs(currentMs: number): void
  patchPractice(patch: Partial<PracticeState>): void
  patchTrack(stemType: StemType, patch: Partial<PracticeState['tracks'][number]>): void
  setSelectedStem(stemType: StemType): void
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  song: null,
  practice: null,
  currentMs: 0,
  playing: false,
  selectedStem: 'vocals',
  loadSong: (song) => set(() => {
    const guitarSplitEnabled = song.practice.guitarSplitEnabled ?? false
    const selectedStem = song.sourceFormat === 'existing-stems'
      ? song.practice.selectedStem ?? song.stems[0]?.type ?? 'vocals'
      : normalizeSelectedStemForGuitarMode(
      song.practice.selectedStem ?? 'vocals',
      guitarSplitEnabled
    ) ?? 'vocals'
    return {
      song,
      practice: {
      ...createDefaultPracticeState(song.id),
      ...song.practice,
      guitarSplitEnabled,
      selectedStem,
      pitchSemitones: normalizePitchSemitones(song.practice.pitchSemitones),
      ...(song.bpm === null ? {} : { metronomeBpm: song.bpm }),
      metronomeOffsetMs: song.beatOffsetMs,
      tracks: song.practice.tracks.map((track) => ({ ...track }))
      },
      currentMs: song.practice.positionMs,
      selectedStem,
      playing: false
    }
  }),
  updateSongDetails: (song) => set((state) => state.song?.id === song.id
    ? { song: { ...song, practice: state.practice ?? song.practice } }
    : state),
  unload: () => set({ song: null, practice: null, currentMs: 0, playing: false }),
  setPlaying: (playing) => set((state) => state.playing === playing ? state : { playing }),
  setCurrentMs: (currentMs) => set((state) => state.currentMs === currentMs ? state : { currentMs }),
  patchPractice: (patch) => set((state) => {
    if (!state.practice) return state
    const guitarSplitEnabled = patch.guitarSplitEnabled ?? state.practice.guitarSplitEnabled
    const selectedStem = state.song?.sourceFormat === 'existing-stems'
      ? patch.selectedStem ?? state.selectedStem
      : normalizeSelectedStemForGuitarMode(
      patch.selectedStem ?? state.selectedStem,
      guitarSplitEnabled
    ) ?? 'vocals'
    return {
      selectedStem,
      practice: {
        ...state.practice,
        ...patch,
        guitarSplitEnabled,
        selectedStem,
        pitchSemitones: normalizePitchSemitones(patch.pitchSemitones ?? state.practice.pitchSemitones)
      }
    }
  }),
  patchTrack: (stemType, patch) => set((state) => state.practice ? {
    practice: {
      ...state.practice,
      tracks: patchTrackStates(state.practice.tracks, stemType, patch, state.practice.guitarSplitEnabled, state.song?.sourceFormat === 'existing-stems')
    }
  } : state),
  setSelectedStem: (selectedStem) => set((state) => ({
    selectedStem,
    practice: state.practice ? { ...state.practice, selectedStem } : state.practice
  }))
}))

/** High frequency input levels are independent of the application/transport tree. */
export const useRecordingMeterStore = create<{ meter: RecordingMeter; setMeter(meter: RecordingMeter): void }>((set) => ({
  meter: { peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: 0, recording: false },
  setMeter: (meter) => set({ meter })
}))
