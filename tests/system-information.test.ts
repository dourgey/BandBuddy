import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSettings, MediaCapabilities, RuntimeInfo } from '../packages/shared/src/domain.js'
import type { DiagnosticReport, EnvironmentState } from '../packages/shared/src/environment.js'
import { SystemInformationService } from '../src/main/system-information.js'

const mocks = vi.hoisted(() => ({ hardware: vi.fn(), graphics: vi.fn(), disk: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '3.0.0', isPackaged: true, getPath: () => 'C:\\private-user\\data', getGPUInfo: mocks.graphics }, net: { isOnline: () => true }, systemPreferences: { getMediaAccessStatus: () => 'granted' } }))
vi.mock('node:fs/promises', () => ({ statfs: mocks.disk }))
vi.mock('../src/main/hardware-diagnostics.js', () => ({ hardwareSnapshot: mocks.hardware }))
vi.mock('../src/main/windows-prerequisites.js', () => ({ detectWindowsVcRuntime: async () => ({ installed: true, version: '14.44.1.0', supported: true }) }))
vi.mock('../src/main/process.js', () => ({ runProcess: vi.fn() }))

function setup() {
  const environment: EnvironmentState = { phase: 'paused', message: '用户暂停准备', progress: null, receivedBytes: 0, totalBytes: null, pausedByUser: true, safeMode: false, capabilities: { startup: 'ready', media: 'ready', recording: 'unchecked', separation: 'unchecked', acceleration: 'unchecked' }, issues: [], checks: [{ id: 'model', component: 'models', stage: '模型验证', status: 'unchecked', level: 'integrity' }] }
  const settings = { libraryRoot: 'C:\\private-user\\songs', runtimeRoot: 'C:\\private-user\\runtime', modelRoot: 'C:\\private-user\\models', preferredDevice: 'auto', recordingAudio: { backend: 'asio', inputDeviceId: 'input-private-id', outputDeviceId: '', inputChannelMode: 'mono', inputChannels: [1], sampleRate: 48000, bufferFrames: 128 }, network: { proxyMode: 'manual', proxyUrl: 'http://secret:credential@private.proxy', pythonIndexUrl: 'https://private:credential@pypi.example/simple?token=hidden', pytorchIndexUrl: '' } } as AppSettings
  const sources = {
    settings: () => settings, environment: () => environment,
    runtime: () => ({ status: 'missing', stage: '尚未安装', selectedDevice: 'cpu', pythonVersion: null, modelReady: false, gpu: { name: 'GPU 1', driverVersion: '100.1', memoryMb: 8192 } } as RuntimeInfo),
    media: () => ({ ffmpegVersion: '7.1', ffmpegVerification: 'unchecked', internalSampleRate: 44100, internalChannels: 2, internalBitDepth: 24, supportedInputFormats: ['wav'], supportedExportFormats: ['flac'] } as MediaCapabilities),
    diagnostics: () => ({ runId: 'current-run', persistenceError: null } as DiagnosticReport),
    devices: vi.fn(async () => [{ id: 'input-private-id', name: 'USB Guitar', backend: 'asio' as const, inputChannels: 2, outputChannels: 2, duplexChannels: 2, sampleRates: [48000], preferredSampleRate: 48000, defaultInput: true, defaultOutput: true }])
  }
  return { service: new SystemInformationService(sources), sources, environment }
}
beforeEach(() => {
  mocks.hardware.mockResolvedValue({ cpu: 'Test CPU', totalMemory: 16 * 1024 ** 3, availableMemory: 8 * 1024 ** 3, devices: [{ kind: 'display', name: 'GPU 1', driverVersion: '100.1', status: 1, problemCode: 0 }] })
  mocks.graphics.mockResolvedValue({ gpuDevice: [{ deviceString: 'GPU 1', active: true, serialNumber: 'excluded-serial' }], privateData: 'excluded-private-data' })
  mocks.disk.mockResolvedValue({ bavail: 10, blocks: 20, bsize: 1024 ** 3 })
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('collects hardware and current detection state, and copies the exact sanitized snapshot', async () => {
  const { service, environment } = setup()
  const report = await service.collect()
  expect(report.text).toContain('Test CPU')
  expect(report.text).toContain('16.00 GiB')
  expect(report.text).toContain('驱动 100.1')
  expect(report.text).toContain('选定输入：USB Guitar')
  expect(report.text).toContain('输入通道：mono · 2')
  expect(report.text).toContain('模型验证：未检测')
  expect(report.text).toContain('FFmpeg：7.1 · 未检测')
  expect(report.text).toContain('在线（不代表下载来源可达）')
  expect(report.text).not.toMatch(/private-user|input-private-id|private\.proxy|credential|token=hidden|excluded-/)
  expect(JSON.stringify(report.sections)).not.toMatch(/credential|private-user/)
  environment.message = '新的检测结果'
  expect(service.text(report.id)).toBe(report.text)
  const next = await service.collect()
  expect(next.id).not.toBe(report.id)
  expect(next.text).toContain('新的检测结果')
  expect(service.text(report.id)).toBe(report.text)
  expect(() => service.text('unrecognized')).toThrow('信息已过期')
})

it('keeps partial hardware/audio/storage failures without hiding the working sections', async () => {
  const { service, sources } = setup()
  mocks.hardware.mockRejectedValue(Object.assign(new Error('Inventory unavailable'), { code: 'HARDWARE_PROBE_FAILED' }))
  sources.devices.mockRejectedValue(Object.assign(new Error('Device busy at C:\\private-user\\driver'), { code: 'AUDIO_DRIVER_PROBE_FAILED' }))
  mocks.disk.mockRejectedValue(Object.assign(new Error('Volume unavailable'), { code: 'EACCES' }))
  mocks.graphics.mockRejectedValue(new Error('GPU disabled'))
  const report = await service.collect()
  expect(report.text).toContain('HARDWARE_PROBE_FAILED')
  expect(report.text).toContain('AUDIO_DRIVER_PROBE_FAILED')
  expect(report.text).toContain('EACCES')
  expect(report.text).toContain('用户暂停准备')
  expect(report.text).toContain('操作系统')
  expect(report.text).not.toContain('private-user')
})

it('coalesces collection and bounds a non-responsive graphics query', async () => {
  vi.useFakeTimers()
  const { service, sources } = setup()
  mocks.graphics.mockImplementation(() => new Promise(() => {}))
  const first = service.collect(), second = service.collect()
  expect(first).toBe(second)
  await vi.advanceTimersByTimeAsync(5001)
  const report = await first
  expect(report.text).toContain('INFORMATION_TIMEOUT')
  expect(sources.devices).toHaveBeenCalledTimes(1)
})
