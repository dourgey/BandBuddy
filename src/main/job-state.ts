import type { JobStatus } from '@shared/domain.js'
import { evidenceText, primaryErrorCode } from './diagnostic-errors.js'

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['blockedRuntime', 'preparing', 'postprocessing', 'cancelled', 'failed'],
  blockedRuntime: ['queued', 'cancelled'],
  preparing: ['blockedRuntime', 'separating', 'postprocessing', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  separating: ['blockedRuntime', 'preparing', 'postprocessing', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  postprocessing: ['completed', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  cancelled: ['queued'],
  interrupted: ['queued'],
  completed: [],
  failed: ['queued']
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return from === to || transitions[from].includes(to)
}

export function classifyJobError(error: unknown, cancelled = false): { code: string; cancelled: boolean } {
  const text = evidenceText(error)
  const isCancelled = cancelled || /^(?:PROCESS_|JOB_|RECORDING_)?CANCELLED$/.test(primaryErrorCode(error))
  const code = isCancelled ? 'CANCELLED'
    : primaryErrorCode(error) === 'CPU_OUT_OF_MEMORY' ? 'CPU_OUT_OF_MEMORY'
    : primaryErrorCode(error) === 'RUNTIME_RECOVERY_PENDING' ? 'RUNTIME_RECOVERY_PENDING'
    : text.includes('CUDA_OOM') ? 'CUDA_OOM'
      : /DISK_FULL|ENOSPC|NO SPACE/.test(text.toUpperCase()) ? 'DISK_FULL'
        : primaryErrorCode(error) === 'UNKNOWN_ERROR' ? 'JOB_FAILED' : primaryErrorCode(error)
  return { code, cancelled: isCancelled }
}
