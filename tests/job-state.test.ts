import { describe, expect, it } from 'vitest'
import { canTransitionJob, classifyJobError } from '../src/main/job-state.js'

describe('background job state machine', () => {
  it('allows cancellation, interruption and retry but keeps completed terminal', () => {
    expect(canTransitionJob('queued', 'blockedRuntime')).toBe(true)
    expect(canTransitionJob('separating', 'cancelling')).toBe(true)
    expect(canTransitionJob('interrupted', 'queued')).toBe(true)
    expect(canTransitionJob('completed', 'queued')).toBe(false)
  })

  it('maps OOM, disk and cancellation to stable error codes', () => {
    expect(classifyJobError(new Error('CUDA_OOM_CPU_RETRY_AVAILABLE')).code).toBe('CUDA_OOM')
    expect(classifyJobError(new Error('No space left on device')).code).toBe('DISK_FULL')
    expect(classifyJobError(new Error('JOB_CANCELLED')).cancelled).toBe(true)
  })
})
