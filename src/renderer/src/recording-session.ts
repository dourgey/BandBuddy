import { useSyncExternalStore } from 'react'
export type RecordingOwner = 'practice' | 'rehearsal'
export interface RecordingControls {
  stop(): Promise<void> | void
  cancel(): Promise<void> | void
  pause?(): Promise<void> | void
  resume?(): Promise<void> | void
}
export interface RecordingSession { owner: RecordingOwner; phase: string; message: string; controls?: RecordingControls }
const states = new Map<RecordingOwner, { phase: string; message: string }>()
const controls = new Map<RecordingOwner, RecordingControls>()
let current: RecordingSession | null = null
const listeners = new Set<() => void>()
export const RECORDING_GUARD_MESSAGE = '录音正在进行，请先停止并保存录音后再播放、换曲或调整音频设备。浏览页面、搜索和切换外观不受影响。'
const busy = (phase: string): boolean => phase !== 'idle' && phase !== 'failed'
function update(): void {
  const entry = [...states].find(([, state]) => busy(state.phase))
  const next = entry ? { owner: entry[0], ...entry[1], controls: controls.get(entry[0]) } : null
  if (current?.owner === next?.owner && current?.phase === next?.phase && current?.message === next?.message && current?.controls === next?.controls) return
  current = next
  listeners.forEach(listener => listener())
}
/** Mirrors authoritative IPC phases; a short starting reservation covers async preflight. */
export function publishRecordingState(owner: RecordingOwner, state: { phase: string; message?: string; songId?: string | null }): void {
  const phase = owner === 'practice' && (state.phase === 'testing' || (state.phase === 'preparing' && state.songId === null)) ? 'idle' : state.phase
  states.set(owner, { phase, message: state.message ?? '' })
  update()
}
export function registerRecordingControls(owner: RecordingOwner, value: RecordingControls): () => void {
  controls.set(owner, value); update()
  return () => { if (controls.get(owner) === value) { controls.delete(owner); update() } }
}
export function getRecordingSession(): RecordingSession | null { return current }
export function isRecordingLocked(): boolean { return current !== null }
export function allowAudioAction(): boolean {
  if (!current) return true
  window.dispatchEvent(new CustomEvent('bandbuddy:recording-blocked', { detail: RECORDING_GUARD_MESSAGE }))
  return false
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useRecordingSession(): RecordingSession | null { return useSyncExternalStore(subscribe, () => current) }
