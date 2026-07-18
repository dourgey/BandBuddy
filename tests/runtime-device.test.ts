import { describe, expect, it } from 'vitest'
import { fallbackComputeDevice, selectComputeDevice } from '../src/main/runtime-device.js'

describe('compute device selection', () => {
  it('selects verified CUDA automatically and otherwise falls back to CPU', () => {
    expect(selectComputeDevice('auto', 'win32', { nvidiaDetected: true, cudaAvailable: true })).toBe('cuda')
    expect(selectComputeDevice('auto', 'win32', { nvidiaDetected: true, cudaAvailable: false })).toBe('cpu')
    expect(selectComputeDevice('cuda', 'win32', { nvidiaDetected: false })).toBe('cpu')
  })

  it('keeps the MPS branch scoped to macOS', () => {
    expect(selectComputeDevice('mps', 'darwin', { nvidiaDetected: false, mpsAvailable: true })).toBe('mps')
    expect(selectComputeDevice('mps', 'win32', { nvidiaDetected: false, mpsAvailable: true })).toBe('cpu')
    expect(selectComputeDevice('cuda', 'darwin', { nvidiaDetected: false, mpsAvailable: true })).toBe('mps')
  })

  it('retries an unavailable accelerator on MPS and then CPU', () => {
    expect(fallbackComputeDevice('cuda', 'darwin', 'CUDA_NOT_AVAILABLE')).toBe('mps')
    expect(fallbackComputeDevice('cuda', 'win32', 'CUDA_NOT_AVAILABLE')).toBe('cpu')
    expect(fallbackComputeDevice('mps', 'darwin', 'MPS_NOT_AVAILABLE')).toBe('cpu')
    expect(fallbackComputeDevice('cpu', 'win32', 'WORKER_FAILED')).toBeNull()
  })
})
