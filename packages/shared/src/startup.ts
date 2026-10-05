import type { Appearance } from './appearance.js'
export interface StartupState {
  phase: 'preparing-database' | 'initializing-services' | 'ready' | 'failed'
  appearance: Appearance
  message: string
  error?: string
  safeMode?: boolean
}
export interface StartupApi {
  snapshot(): StartupState
  get(): Promise<StartupState>
  onChanged(callback: (state: StartupState) => void): () => void
  painted(): Promise<void>
  interactive?(): Promise<void>
  repairSystem?(): Promise<void>
  restoreBackup?(): Promise<void>
  recover?(safe: boolean): Promise<void>
  revealRecovery?(): Promise<void>
}
