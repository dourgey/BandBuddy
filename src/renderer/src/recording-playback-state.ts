import { create } from 'zustand'

export interface RecordingPlaybackStatus { phase: 'loading' | 'ready' | 'failed'; error?: string }
export const useRecordingPlayback = create<{ tracks: Record<string, RecordingPlaybackStatus> }>(() => ({ tracks: {} }))
export function setRecordingPlayback(id: string, status: RecordingPlaybackStatus | null): void {
  useRecordingPlayback.setState(state => {
    const tracks = { ...state.tracks }
    if (status) tracks[id] = status
    else delete tracks[id]
    return { tracks }
  })
}
