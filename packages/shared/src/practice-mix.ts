import { dbToGain, isStemVisible, stemPlaybackGain, type PracticeState, type RecordingTake, type SongDetail } from './domain.js'

/** A selected take is a mixer track even while its replacement audio is loading. */
export function practiceMix(song: SongDetail, practice: PracticeState): { solo: boolean; gains: Map<string, number> } {
  const stems = practice.tracks.filter(t => song.stems.some(s => s.type === t.stemType)
    && (song.sourceFormat === 'existing-stems' || isStemVisible(t.stemType, practice.guitarSplitEnabled, practice.vocalSplitEnabled)))
  const recordings = song.recordingTracks.filter(t => song.recordingTakes.some(take => take.id === t.activeTakeId))
  const solo = [...stems, ...recordings].some(t => t.solo && !t.muted)
  const gains = new Map<string, number>()
  for (const track of [...stems, ...recordings]) {
    const id = 'stemType' in track ? track.stemType : track.id
    gains.set(id, !track.muted && (!solo || track.solo)
      ? dbToGain(track.gainDb) * ('stemType' in track ? stemPlaybackGain(song.stems.find(s => s.type === id)) : 1) : 0)
  }
  return { solo, gains }
}

export function recordingPlaybackRate(take: RecordingTake, practice: PracticeState): number {
  return practice.playbackRate / take.playbackRate
}
export function recordingPitch(take: RecordingTake, practice: PracticeState): number {
  return (practice.pitchSemitones ?? 0) - (take.pitchSemitones ?? 0)
}
export function recordingPreviewUrl(take: RecordingTake, practice: PracticeState): string {
  const url = new URL(take.previewMediaUrl)
  url.searchParams.set('pitch', String(recordingPitch(take, practice)))
  return url.href
}
