import { describe, expect, it } from 'vitest'
import type { NetworkSettings } from '../packages/shared/src/domain.js'
import { networkSettingsSchema } from '../packages/shared/src/ipc.js'
import {
  RUNTIME_SOURCE_PRESETS,
  applyRuntimeSourcePreset,
  matchRuntimeSourcePreset,
  resolvePytorchSourceUrl,
  selectPytorchBackend
} from '../packages/shared/src/runtime-sources.js'

const network = (preset: 'china' | 'official'): NetworkSettings => ({
  proxyMode: 'system',
  proxyUrl: '',
  ...RUNTIME_SOURCE_PRESETS[preset]
})

describe('runtime download sources', () => {
  it('recognizes presets and keeps proxy settings when switching', () => {
    const china = network('china')
    expect(matchRuntimeSourcePreset(china)).toBe('china')
    expect(applyRuntimeSourcePreset({ ...china, proxyMode: 'manual', proxyUrl: 'https://127.0.0.1:7890' }, 'official')).toEqual({
      proxyMode: 'manual',
      proxyUrl: 'https://127.0.0.1:7890',
      ...RUNTIME_SOURCE_PRESETS.official
    })
    expect(matchRuntimeSourcePreset({ ...china, modelBaseUrl: 'https://example.com/models/' })).toBeNull()
  })

  it('selects the newest mirrored CUDA backend supported by the driver', () => {
    expect(selectPytorchBackend('win32', '13.3', 'auto')).toBe('cu130')
    expect(selectPytorchBackend('win32', '12.9', 'cuda')).toBe('cu129')
    expect(selectPytorchBackend('win32', '12.8', 'auto')).toBe('cu128')
    expect(selectPytorchBackend('win32', '12.7', 'auto')).toBe('cu126')
    expect(selectPytorchBackend('win32', '12.5', 'auto')).toBe('cpu')
    expect(selectPytorchBackend('win32', '13.0', 'cpu')).toBe('cpu')
    expect(selectPytorchBackend('darwin', null, 'auto')).toBe('cpu')
  })

  it('expands a mirrored PyTorch wheel template', () => {
    expect(resolvePytorchSourceUrl(RUNTIME_SOURCE_PRESETS.china.pytorchIndexUrl, 'cu130'))
      .toBe('https://mirrors.aliyun.com/pytorch-wheels/cu130/')
  })

  it('accepts both built-in source presets at the IPC boundary', () => {
    expect(networkSettingsSchema.parse(network('china'))).toEqual(network('china'))
    expect(networkSettingsSchema.parse(network('official'))).toEqual(network('official'))
  })
})
