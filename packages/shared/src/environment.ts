export type EnvironmentCapability = 'startup' | 'media' | 'recording' | 'separation' | 'acceleration'
export type EnvironmentPhase = 'checking' | 'preparing' | 'ready' | 'paused' | 'waitingNetwork' | 'waitingIdle' | 'needsAction'
export type EnvironmentAction = 'retry' | 'repair' | 'storage' | 'network' | 'audio' | 'microphone' | 'driver' | 'time' | 'security' | 'restart' | 'repairApplication'
export interface EnvironmentIssue { code: string; message: string; action: EnvironmentAction; capability: EnvironmentCapability }
export interface EnvironmentState {
  phase: EnvironmentPhase
  message: string
  progress: number | null
  receivedBytes: number
  totalBytes: number | null
  pausedByUser: boolean
  safeMode: boolean
  capabilities: Record<EnvironmentCapability, 'unchecked' | 'ready' | 'unavailable'>
  issues: EnvironmentIssue[]
}
export const ENVIRONMENT_CHANNEL = 'environment:request'
export const ENVIRONMENT_CHANGED = 'environment:changed'
export interface EnvironmentApi {
  get(): Promise<EnvironmentState>
  check(): Promise<EnvironmentState>
  prepare(): Promise<EnvironmentState>
  pause(): Promise<EnvironmentState>
  resume(): Promise<EnvironmentState>
  repair(): Promise<EnvironmentState>
  networkRestored(): Promise<void>
  devicesChanged?(): Promise<void>
  exportDiagnostics(): Promise<string | null>
  openAction(action: EnvironmentAction): Promise<void>
  onChanged(callback: (state: EnvironmentState) => void): () => void
}
