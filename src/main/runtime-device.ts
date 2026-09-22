import type { ComputeDevice } from '@shared/domain.js'

export interface DeviceAvailability {
  nvidiaDetected: boolean
  cudaAvailable?: boolean
  mpsAvailable?: boolean
}

export function selectComputeDevice(
  preferred: ComputeDevice,
  platform: NodeJS.Platform,
  availability: DeviceAvailability,
  arch: string = process.arch
): 'cuda' | 'mps' | 'cpu' {
  const cuda = availability.nvidiaDetected && availability.cudaAvailable !== false
  const mps = platform === 'darwin' && arch !== 'x64' && availability.mpsAvailable !== false
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
  void platform
  if (
    current !== 'cpu' &&
    ['CUDA_NOT_AVAILABLE', 'MPS_NOT_AVAILABLE', 'ACCELERATOR_OOM', 'CUDA_OOM'].includes(failureCode ?? '')
  ) return 'cpu'
  return null
}
