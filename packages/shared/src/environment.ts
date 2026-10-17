export type EnvironmentCapability = 'startup' | 'media' | 'recording' | 'separation' | 'acceleration'
export type EnvironmentPhase = 'checking' | 'preparing' | 'ready' | 'paused' | 'waitingNetwork' | 'waitingIdle' | 'needsAction'
export type EnvironmentAction = 'retry' | 'repair' | 'storage' | 'network' | 'audio' | 'microphone' | 'driver' | 'time' | 'security' | 'restart' | 'repairApplication'
export type EnvironmentComponent = 'startup' | 'storage' | 'network' | 'system-runtime' | 'media' | 'python' | 'dependencies' | 'models' | 'compute' | 'audio-host' | 'audio-device' | 'task'
export type VerificationLevel = 'inventory' | 'integrity' | 'launch' | 'imports' | 'inference' | 'stream'
export interface ErrorEvidence {
  name: string
  code: string
  message: string
  stack?: string
  details?: Record<string, unknown>
  causes?: ErrorEvidence[]
}
export interface EnvironmentCheck {
  id: string
  component: EnvironmentComponent
  stage: string
  status: 'unchecked' | 'passed' | 'failed' | 'blocked' | 'notApplicable'
  level: VerificationLevel
  checkedAt?: string
  blockedBy?: string
  diagnosticId?: string
  detail?: string
}
export interface RecoveryAttempt { at: string; action: string; result: string }
export interface EnvironmentIssue {
  code: string; message: string; action: EnvironmentAction; capability: EnvironmentCapability
  diagnosticId?: string
  runId?: string
  component?: EnvironmentComponent
  stage?: string
  confidence?: 'confirmed' | 'suspected' | 'unknown'
  severity?: 'error' | 'warning'
  evidence?: ErrorEvidence
  affectedCapabilities?: EnvironmentCapability[]
  nextSteps?: string[]
  attempts?: RecoveryAttempt[]
  resolvedAt?: string
}
export interface DiagnosticEvent {
  id: string; runId: string; at: string; component: EnvironmentComponent; stage: string
  result: string; diagnosticId?: string; jobId?: string; details?: unknown
}
export interface DiagnosticScope { diagnosticId?: string; jobId?: string }
export interface DiagnosticReport {
  schema: 2; runId: string; applicationVersion: string; platform: string; arch: string; os: string
  issues: EnvironmentIssue[]; events: DiagnosticEvent[]; persistenceError: ErrorEvidence | null
  summary: string
}
export interface SystemInformationSection {
  title: string
  rows: Array<{ label: string; value: string }>
}
export interface SystemInformationReport {
  id: string
  collectedAt: string
  sections: SystemInformationSection[]
  text: string
}
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
  checks?: EnvironmentCheck[]
  runId?: string
}
export const ENVIRONMENT_CHANNEL = 'environment:request'
export const ENVIRONMENT_CHANGED = 'environment:changed'
export interface EnvironmentApi {
  get(): Promise<EnvironmentState>
  check(diagnosticId?: string): Promise<EnvironmentState>
  prepare(): Promise<EnvironmentState>
  pause(): Promise<EnvironmentState>
  resume(): Promise<EnvironmentState>
  repair(diagnosticId?: string): Promise<EnvironmentState>
  networkRestored(): Promise<void>
  devicesChanged?(): Promise<void>
  exportDiagnostics(scope?: DiagnosticScope): Promise<string | null>
  diagnostics?(scope?: DiagnosticScope): Promise<DiagnosticReport>
  copyDiagnostics?(scope?: DiagnosticScope): Promise<void>
  systemInformation?(): Promise<SystemInformationReport>
  copySystemInformation?(id: string): Promise<void>
  openAction(action: EnvironmentAction, diagnosticId?: string): Promise<void>
  onChanged(callback: (state: EnvironmentState) => void): () => void
}
