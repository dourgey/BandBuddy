import type { ComputeDevice } from '@shared/domain.js'

export interface DeviceAvailability {
  nvidiaDetected: boolean
  cudaAvailable?: boolean
  mpsAvailable?: boolean
}

export function selectComputeDevice(
  preferred: ComputeDevice,
  platform: NodeJS.Platform,
  availability: DeviceAvailability
): 'cuda' | 'mps' | 'cpu' {
  const cuda = availability.nvidiaDetected && availability.cudaAvailable !== false
  const mps = platform === 'darwin' && availability.mpsAvailable !== false
  if (preferred === 'cpu') return 'cpu'
  if (preferred === 'cuda') return cuda ? 'cuda' : mps ? 'mps' : 'cpu'
  if (preferred === 'mps') return mps ? 'mps' : 'cpu'
  if (cuda) return 'cuda'
  if (mps) return 'mps'
  return 'cpu'
}

export function fallbackComputeDevice(
  current: 'cuda' | 'mps' | 'cpu',
  platform: NodeJS.Platform,
  failureCode: string | null
): 'mps' | 'cpu' | null {
  if (current === 'cuda' && failureCode === 'CUDA_NOT_AVAILABLE') return platform === 'darwin' ? 'mps' : 'cpu'
  if (current === 'mps' && failureCode === 'MPS_NOT_AVAILABLE') return 'cpu'
  return null
}
