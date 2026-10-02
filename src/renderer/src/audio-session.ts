import { useSyncExternalStore } from 'react'

export type AudioSessionOwner = 'practice' | 'rehearsal' | 'woodshed'
export interface AudioSession { id: number; owner: AudioSessionOwner; label: string; pause(): void }
let current: AudioSession | null = null
let sequence = 0
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach(listener => listener())
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useAudioSession(): AudioSession | null { return useSyncExternalStore(subscribe, () => current) }
export function getAudioSession(): AudioSession | null { return current }
/** Navigating never claims a session. Only an explicit play/preview command does. */
export function claimAudioSession(owner: AudioSessionOwner, label: string, pause: () => void): number {
  if (current && current.owner !== owner) pauseAudioSession()
  current = { id: ++sequence, owner, label, pause }
  notify()
  return current.id
}
export function isAudioSessionCurrent(id: number): boolean { return current?.id === id }
export function releaseAudioSession(owner: AudioSessionOwner, id?: number): void {
  if (current?.owner !== owner || (id !== undefined && current.id !== id)) return
  current = null
  notify()
}
export function pauseAudioSession(): void {
  const active = current
  if (!active) return
  current = null
  notify()
  active.pause()
}
