import type { ComputeDevice, NetworkSettings } from './domain.js'

export const RUNTIME_SOURCE_PRESETS = {
  china: {
    pythonInstallMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone/',
    pythonIndexUrl: 'https://mirrors.aliyun.com/pypi/simple',
    pytorchIndexUrl: 'https://mirrors.aliyun.com/pytorch-wheels/{backend}/',
    modelBaseUrl: 'https://modelscope.cn/models/pengzhendong/uvr-demucs/resolve/6938a11d024a7fffa0d9c09e79b1ba2cbcb13239/v3_v4_repo/'
  },
  official: {
    pythonInstallMirror: '',
    pythonIndexUrl: 'https://pypi.org/simple',
    pytorchIndexUrl: '',
    modelBaseUrl: 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/'
  }
} as const

export type RuntimeSourcePreset = keyof typeof RUNTIME_SOURCE_PRESETS
export type PytorchBackend = 'cpu' | 'cu126' | 'cu128' | 'cu129' | 'cu130'

const SOURCE_KEYS = ['pythonInstallMirror', 'pythonIndexUrl', 'pytorchIndexUrl', 'modelBaseUrl'] as const

export function applyRuntimeSourcePreset(network: NetworkSettings, preset: RuntimeSourcePreset): NetworkSettings {
  return { ...network, ...RUNTIME_SOURCE_PRESETS[preset] }
}

export function matchRuntimeSourcePreset(network: NetworkSettings): RuntimeSourcePreset | null {
  for (const preset of Object.keys(RUNTIME_SOURCE_PRESETS) as RuntimeSourcePreset[]) {
    const values = RUNTIME_SOURCE_PRESETS[preset]
    if (SOURCE_KEYS.every((key) => network[key] === values[key])) return preset
  }
  return null
}

function versionNumber(value: string | null): number | null {
  if (!value) return null
  const match = /^(\d+)\.(\d+)/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 100 + Number(match[2])
}

export function selectPytorchBackend(
  platform: string,
  cudaVersion: string | null,
  preferredDevice: ComputeDevice
): PytorchBackend {
  if (platform !== 'win32' || preferredDevice === 'cpu' || preferredDevice === 'mps') return 'cpu'
  const cuda = versionNumber(cudaVersion)
  if (cuda === null || cuda < 1206) return 'cpu'
  if (cuda >= 1300) return 'cu130'
  if (cuda >= 1209) return 'cu129'
  if (cuda >= 1208) return 'cu128'
  return 'cu126'
}

export function resolvePytorchSourceUrl(template: string, backend: PytorchBackend): string {
  return template.replaceAll('{backend}', backend)
}
