import type { BandBuddyApi } from '@shared/bridge.js'
import { fixtureDetail, fixtureSongs } from './fixtures.js'

const noop = (): (() => void) => () => undefined

export function installFixtureBridge(): void {
  if (window.bandbuddy) return
  const settings = {
    libraryRoot: 'C:\\Users\\Musician\\BandBuddy\\music',
    runtimeRoot: 'C:\\Users\\Musician\\BandBuddy\\envs',
    modelRoot: 'C:\\Users\\Musician\\BandBuddy\\envs\\models',
    preferredDevice: 'auto' as const,
    audioOutputDeviceId: '', latencyMode: 'balanced' as const, keepSource: true, closeToTrayWhileWorking: true,
    network: { proxyMode: 'system' as const, proxyUrl: '', pythonIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple', pytorchIndexUrl: '' }
  }
  const runtime = {
    status: 'ready' as const, stage: '环境就绪 · CUDA', progress: 1, device: 'auto' as const, selectedDevice: 'cuda' as const,
    gpu: { name: 'NVIDIA GeForce RTX 4070', driverVersion: '590.18', memoryMb: 12282 },
    pythonVersion: '3.12.10', torchVersion: '2.11.0+cu130', cudaVersion: '13.0', demucsVersion: '4.1.0', modelReady: true,
    modelRevision: 'htdemucs_6s:5c90dfd2-34c22ccb', runtimePath: settings.runtimeRoot, modelPath: settings.modelRoot, error: null
  }
  const api: BandBuddyApi = {
    library: {
      list: async () => fixtureSongs,
      get: async (id) => { const song = fixtureSongs.find((item) => item.id === id); return song ? fixtureDetail(song) : null },
      chooseSource: async () => null, chooseStems: async () => [],
      importSource: async () => ({ songId: null, jobId: null, duplicate: null, needsPadding: false, durationDifferenceMs: 0, warnings: [] }),
      importStems: async () => ({ songId: null, jobId: null, duplicate: null, needsPadding: false, durationDifferenceMs: 0, warnings: [] }),
      update: async ({ id, patch }) => { const found = fixtureSongs.find((item) => item.id === id)!; return { ...fixtureDetail(found), ...patch } },
      delete: async () => undefined, openLocation: async () => undefined, reSeparate: async () => '99999999-9999-4999-8999-999999999999', savePractice: async () => undefined, onChanged: noop
    },
    tasks: { list: async () => [], cancel: async () => undefined, retry: async () => undefined, clearFinished: async () => undefined, onChanged: noop },
    runtime: { get: async () => runtime, detect: async () => runtime, install: async () => runtime, cancel: async () => undefined, repair: async () => runtime, remove: async () => undefined, clearModel: async () => undefined, onChanged: noop },
    settings: {
      get: async () => settings,
      chooseDataRoot: async () => ({ dataRoot: 'C:\\Users\\Musician\\BandBuddy', libraryRoot: settings.libraryRoot, runtimeRoot: settings.runtimeRoot, modelRoot: settings.modelRoot }),
      update: async (value) => value,
      onChanged: noop
    },
    media: {
      capabilities: async () => ({ ffmpegReady: true, ffmpegVersion: '8.1.2', protocolVersion: 1, supportedInputFormats: ['mp3', 'wav', 'flac', 'm4a', 'aac'], supportedExportFormats: ['wav', 'flac', 'mp3'], internalSampleRate: 44100, internalChannels: 2, internalBitDepth: 24 }),
      detectBpm: async () => ({ bpm: 124, confidence: 0.9, beatOffsetMs: 0, analyzedStem: 'drums' }),
      onChanged: noop
    },
    export: { choosePath: async () => null, start: async () => ({ jobId: '99999999-9999-4999-8999-999999999999', outputPaths: [] }) },
    window: { minimize: async () => undefined, toggleMaximize: async () => false, close: async () => undefined, onHidden: noop }
  }
  window.bandbuddy = api
}
