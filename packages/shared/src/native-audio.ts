import type { PracticeState } from './domain.js'
export const NATIVE_AUDIO_CHANNEL = 'native-audio:request'
export const NATIVE_AUDIO_EVENT = 'native-audio:state'
export interface NativeAudioState {
  positionMs: number; playing: boolean; ended: boolean; generation: number; countInRemaining: number
  underruns: number; error: string; sampleRate?: number
}
export interface NativeAudioApi {
  enabled(): Promise<boolean>
  load(songId: string, practice: PracticeState): Promise<void>
  refresh(songId: string): Promise<void>
  update(practice: PracticeState): Promise<void>
  play(countInBeats?: number): Promise<void>
  pause(): Promise<void>
  seek(positionMs: number): Promise<void>
  unload(): Promise<void>
  onState(callback: (state: NativeAudioState) => void): () => void
}
