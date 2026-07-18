import type { JobStatus } from '@shared/domain.js'

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['blockedRuntime', 'preparing', 'postprocessing', 'cancelled', 'failed'],
  blockedRuntime: ['queued', 'cancelled'],
  preparing: ['separating', 'postprocessing', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  separating: ['preparing', 'postprocessing', 'cancelling', 'cancelled', 'failed', 'interrupted'],
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
  const text = String(error)
  const isCancelled = cancelled || text.includes('CANCELLED')
  const code = isCancelled ? 'CANCELLED'
    : text.includes('CUDA_OOM') ? 'CUDA_OOM'
      : text.includes('DISK') || text.toUpperCase().includes('NO SPACE') ? 'DISK_FULL'
        : text.split(':')[0]?.replace(/^Error:\s*/, '') || 'JOB_FAILED'
  return { code, cancelled: isCancelled }
}
