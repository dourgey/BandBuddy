import { create } from 'zustand'
import { createDefaultPracticeState, type PracticeState, type SongDetail, type StemType, type TrackState } from '@shared/domain.js'

export function patchTrackStates(tracks: readonly TrackState[], stemType: StemType, patch: Partial<TrackState>): TrackState[] {
  const enablesSolo = patch.solo === true
  return tracks.map((track) => {
    if (track.stemType !== stemType) return enablesSolo && track.solo ? { ...track, solo: false } : track
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
  loadSong: (song) => set({
    song,
    practice: {
      ...createDefaultPracticeState(song.id),
      ...song.practice,
      ...(song.bpm === null ? {} : { metronomeBpm: song.bpm }),
      metronomeOffsetMs: song.beatOffsetMs,
      tracks: song.practice.tracks.map((track) => ({ ...track }))
    },
    currentMs: song.practice.positionMs,
    selectedStem: song.practice.selectedStem ?? 'vocals',
    playing: false
  }),
  unload: () => set({ song: null, practice: null, currentMs: 0, playing: false }),
  setPlaying: (playing) => set({ playing }),
  setCurrentMs: (currentMs) => set({ currentMs }),
  patchPractice: (patch) => set((state) => state.practice ? { practice: { ...state.practice, ...patch } } : state),
  patchTrack: (stemType, patch) => set((state) => state.practice ? {
    practice: {
      ...state.practice,
      tracks: patchTrackStates(state.practice.tracks, stemType, patch)
    }
  } : state),
  setSelectedStem: (selectedStem) => set((state) => ({
    selectedStem,
    practice: state.practice ? { ...state.practice, selectedStem } : state.practice
  }))
}))
