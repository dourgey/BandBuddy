import type { Appearance } from './appearance.js'
export interface StartupState {
  phase: 'preparing-database' | 'initializing-services' | 'ready' | 'failed'
  appearance: Appearance
  message: string
  error?: string
}
export interface StartupApi {
  snapshot(): StartupState
  get(): Promise<StartupState>
  onChanged(callback: (state: StartupState) => void): () => void
  painted(): Promise<void>
}
