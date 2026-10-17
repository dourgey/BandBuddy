import os from 'node:os'
import { systemHelper } from './system-helper.js'
import { DiagnosticError, errorEvidence } from './diagnostic-errors.js'

export interface HardwareSnapshot {
  platform: string; arch: string; os: string; cpu: string; processors: number; totalMemory: number; availableMemory: number
  devices: Array<{ kind: string; name?: string; manufacturer?: string; driverVersion?: string; driverProvider?: string; status?: number; problemCode?: number; probeError?: number }>
  probeError?: import('@shared/environment.js').ErrorEvidence
}
export async function hardwareSnapshot(): Promise<HardwareSnapshot> {
  const snapshot: HardwareSnapshot = { platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model ?? 'unknown', processors: os.availableParallelism(), totalMemory: os.totalmem(), availableMemory: os.freemem(), devices: [] }
  if (process.platform !== 'win32') return snapshot
  try {
    const result = await systemHelper(['inventory'], 10_000)
    if (result.code !== 0) throw new DiagnosticError('HARDWARE_PROBE_FAILED', '硬件清单进程未完成', { result })
    const value = JSON.parse(result.stdout)
    if (value.schema !== 1 || !Array.isArray(value.devices)) throw new Error('HARDWARE_PROBE_FAILED:INVALID_RESPONSE')
    snapshot.devices = value.devices
    if (value.memoryKnown) { snapshot.totalMemory = value.totalMemory; snapshot.availableMemory = value.availableMemory }
  } catch (error) { snapshot.probeError = errorEvidence(error) }
  return snapshot
}
