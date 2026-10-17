import { z } from 'zod'

export const PLUGINS_CHANNEL = 'audio-plugins:request'
export const externalPluginSchema = z.object({
  instanceId: z.string().uuid(), format: z.enum(['vst3', 'auv2']), pluginId: z.string().min(1).max(256),
  name: z.string().min(1).max(256), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  bypass: z.boolean().default(false),
  // Insert before this built-in module, or at the end. Definition and instance
  // identities are separate so repeated effects retain independent state.
  beforeModuleId: z.string().max(80).nullable().default(null)
})
export type ExternalPlugin = z.infer<typeof externalPluginSchema>
export interface PluginDefinition {
  format: 'vst3' | 'auv2'; pluginId: string; name: string; manufacturer: string; version: string
  path: string; fingerprint: string; architecture: string; instrument: boolean
  validation: 'available' | 'failed' | 'unsupported'; failureReason?: string
  hasEditor?: boolean; inputChannels?: number; outputChannels?: number; latencyFrames?: number; tailSeconds?: number
}
export interface PluginCatalog {
  version: 1; plugins: PluginDefinition[]; directories: string[]
  failures: Array<{ path: string; fingerprint: string; reason: string; checkedAt: string }>
}
export interface PluginParameter { id: number; name: string; unit: string; value: number; steps: number; readOnly: boolean }
export interface PluginRuntimeState { active: boolean; fault: boolean; error: string | null; latencyFrames: number; restarts: number }
export interface PluginFaults { intervals: Array<{ startFrame: number; endFrame: number }>; droppedIntervals: number; clock: 'output-samples' }
export interface AudioDiagnostics {
  callbacks: number; callbackMaxUs: number; callbackP99UpperUs: number; callbackP999UpperUs: number
  callbackDeadlineMisses: number; actualBufferFrames: number; minBufferFrames: number; maxBufferFrames: number
  inputOverflows: number; outputUnderflows: number; invalidSamples: number; limitedFrames: number
  finalPeak: number; limiterReductionDb: number
}
export interface ClockDiagnostics { relationship: string; inputAdcSeconds: number; outputDacSeconds: number; fifoFrames: number; ratio: number; underruns: number; overflows: number; latencyFrames: number }
export interface PluginDiagnostics { deadlineMisses: number; queueOverflows: number; invalidSamples: number; lastFaultPosition: number; latencyFrames: number }
export interface AudioPluginsApi {
  list(): Promise<PluginCatalog>
  scan(retryFailed?: boolean): Promise<PluginCatalog>
  addDirectory(): Promise<PluginCatalog>
  editor(instanceId: string, open?: boolean): Promise<void>
  parameters(instanceId: string): Promise<PluginParameter[]>
  parameter(instanceId: string, parameterId: number, value: number): Promise<void>
  save(instanceId: string): Promise<string>
  status(): Promise<PluginRuntimeState>
}
