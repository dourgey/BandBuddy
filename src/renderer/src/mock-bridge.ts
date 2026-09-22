import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from '@shared/appearance.js'
import type { AppSettings } from '@shared/domain.js'
import { SOURCE_MEDIA_EXTENSIONS } from '@shared/media-formats.js'
import type { BandBuddyApi } from '@shared/bridge.js'
import { createDefaultRecordingAudioSettings, createDefaultRecordingTrackState } from '@shared/domain.js'
import type { RehearsalRecordingState, RehearsalSetDetail } from '@shared/rehearsal.js'
import { fixtureDetail, fixtureRehearsal, fixtureSongs } from './fixtures.js'
import { defaultEffectChain, type ArsenalApi } from '@shared/arsenal.js'

const noop = (): (() => void) => () => undefined

export function installFixtureBridge(): void {
  if (window.bandbuddy) return
  let cachedAppearance = DEFAULT_APPEARANCE
  try { cachedAppearance = normalizeAppearance(JSON.parse(localStorage.getItem('bandbuddy.appearance.v1') ?? 'null')) } catch { /* Fixture storage is optional. */ }
  const settings: AppSettings = {
    appearance: { ...cachedAppearance },
    libraryRoot: 'C:\\Users\\Musician\\BandBuddy\\music',
    runtimeRoot: 'C:\\Users\\Musician\\BandBuddy\\envs',
    modelRoot: 'C:\\Users\\Musician\\BandBuddy\\envs\\models',
    debugMode: false,
    desktopLyricsFontSize: 24,
    highQualityStems: false,
    guitarSeparationQuality: 'balanced' as const,
    preferredDevice: 'auto' as const,
    audioOutputDeviceId: '', latencyMode: 'balanced' as const, recordingAudio: createDefaultRecordingAudioSettings(), keepSource: true, closeToTrayWhileWorking: true,
    network: {
      proxyMode: 'system' as const,
      proxyUrl: '',
      pythonInstallMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone/',
      pythonIndexUrl: 'https://mirrors.aliyun.com/pypi/simple',
      pytorchIndexUrl: 'https://mirrors.aliyun.com/pytorch-wheels/{backend}/'
    }
  }
  const runtime = {
    status: 'ready' as const, stage: '环境就绪 · CUDA', progress: 1, device: 'auto' as const, selectedDevice: 'cuda' as const,
    gpu: { name: 'NVIDIA GeForce RTX 4070', driverVersion: '590.18', memoryMb: 12282 },
    windowsVcRuntimeVersion: '14.50.35719.0', pythonVersion: '3.12.10', torchVersion: '2.11.0+cu130', cudaVersion: '13.0', modelReady: true,
    runtimePath: settings.runtimeRoot, modelPath: settings.modelRoot, error: null
  }
  let rehearsal = structuredClone(fixtureRehearsal)
  const rehearsalIdle = (): RehearsalRecordingState => ({
    target: 'rehearsal',
    phase: 'idle', sessionId: null, rehearsalId: null, recordingTrackId: null, revisionId: null,
    timelineFingerprint: null, timelinePositionMs: 0, preRollRemaining: 0, sampleRate: 0,
    bufferFrames: 0, latencyMs: 0, xruns: 0, splitDevices: false, message: '', error: null
  })
  const appearanceListeners = new Set<(value: Appearance) => void>()
  const api: BandBuddyApi = {
    appearance: {
      get: async () => settings.appearance,
      set: async (value) => { settings.appearance = normalizeAppearance(value); appearanceListeners.forEach(listener => listener(settings.appearance)); return settings.appearance },
      onChanged: (listener) => { appearanceListeners.add(listener); return () => appearanceListeners.delete(listener) }
    },
    arsenal: {
      list: async () => ({ assets: [], presets: [{ id: '99999999-9999-4999-8999-999999999999', name: '干净起点', chain: defaultEffectChain(), revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }),
      importAsset: async () => null,
      deleteAsset: async () => undefined,
      savePreset: async (input) => ({ id: input.id ?? crypto.randomUUID(), name: input.name, chain: input.chain, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      deletePreset: async () => undefined,
      setTrack: async () => undefined,
      prepare: async (chain) => ({ chain, model: null, modelRate: 48000, ir: null, irRate: 48000 }),
      monitor: async ({ mode }) => ({ active: mode !== 'off', mode, sampleRate: 48000, bufferFrames: 128, latencyMs: 5.3, peak: [0, 0], outputPeak: 0, xruns: 0, error: null }),
      monitorState: async () => ({ active: false, mode: 'off', sampleRate: 0, bufferFrames: 0, latencyMs: 0, peak: [], outputPeak: 0, xruns: 0, error: null }),
      onMonitor: noop
    } satisfies ArsenalApi,
    library: {
      onUpdated: noop,
      listPage: async ({ query = '', filter = 'all', offset = 0, limit = 50 } = {}) => {
        const items = fixtureSongs.filter(song => `${song.title} ${song.artist}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
          .filter(song => filter === 'favorite' ? song.favorite : filter === 'processing' ? song.status !== 'ready' : filter === 'recent' ? Boolean(song.lastPracticedAt) : true)
          .sort((a, b) => filter === 'recent' ? (b.lastPracticedAt ?? '').localeCompare(a.lastPracticedAt ?? '') : 0)
        return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
      },
      list: async () => fixtureSongs,
      get: async (id) => { const song = fixtureSongs.find((item) => item.id === id); return song ? fixtureDetail(song) : null },
      getPathForFile: () => '',
      chooseStems: async () => [],
      importStems: async () => ({ songId: null, jobId: null, duplicate: null }),
      chooseSource: async () => null,
      importSource: async () => ({ songId: null, jobId: null, duplicate: null }),
      requestGuitarSplit: async () => null,
      importLyrics: async (id) => { const song = fixtureSongs.find((item) => item.id === id); return song ? fixtureDetail(song) : null },
      update: async ({ id, patch }) => { const found = fixtureSongs.find((item) => item.id === id)!; return { ...fixtureDetail(found), ...patch } },
      delete: async () => undefined, openLocation: async () => undefined, reSeparate: async () => '99999999-9999-4999-8999-999999999999', savePractice: async () => undefined, onChanged: noop,
      onGuitarSplitCompleted: noop
    },
    tasks: { list: async () => [], cancel: async () => undefined, retry: async () => undefined, clearFinished: async () => undefined, onChanged: noop },
    runtime: { get: async () => runtime, detect: async () => runtime, install: async () => runtime, cancel: async () => undefined, repair: async () => runtime, remove: async () => undefined, clearModel: async () => undefined, onChanged: noop },
    lan: {
      status: async () => ({ enabled: false, port: null, urls: [], error: null }),
      setEnabled: async () => ({ enabled: false, port: null, urls: [], error: '预览模式无法启动服务，请在桌面 App 中使用' })
    },
    settings: {
      reconcileAudio: async () => settings,
      get: async () => settings,
      chooseDataRoot: async () => ({ dataRoot: 'C:\\Users\\Musician\\BandBuddy', libraryRoot: settings.libraryRoot, runtimeRoot: settings.runtimeRoot, modelRoot: settings.modelRoot }),
      update: async (value) => value,
      setDebugMode: async (enabled) => ({ ...settings, debugMode: enabled }),
      revealDebugLog: async () => undefined,
      onChanged: noop
    },
    media: {
      prepareOutputDevice: async () => false,
      capabilities: async () => ({ ffmpegReady: true, ffmpegVersion: '8.1.2', protocolVersion: 1, supportedInputFormats: [...SOURCE_MEDIA_EXTENSIONS].map(extension => extension.slice(1)), supportedExportFormats: ['wav', 'flac', 'mp3'], internalSampleRate: 44100, internalChannels: 2, internalBitDepth: 24 }),
      detectBpm: async () => ({ bpm: 124, confidence: 0.9, beatOffsetMs: 0, analyzedStem: 'drums' }),
      detectKey: async () => ({
        tonic: 'G', mode: 'major', label: 'G major', confidence: 0.62, lowConfidence: true,
        candidates: [
          { tonic: 'G', mode: 'major', label: 'G major', confidence: 0.62 },
          { tonic: 'E', mode: 'minor', label: 'E minor', confidence: 0.28 },
          { tonic: 'D', mode: 'major', label: 'D major', confidence: 0.07 }
        ],
        segments: [
          { tonic: 'G', mode: 'major', label: 'G major', confidence: 0.7, startMs: 0, endMs: 180_000, possibleModulation: false },
          { tonic: 'D', mode: 'major', label: 'D major', confidence: 0.55, startMs: 180_000, endMs: 298_000, possibleModulation: true }
        ],
        analyzedStems: ['bass', 'guitar', 'piano', 'other', 'vocals'], analyzedDurationMs: 298_000, analyzedAt: new Date().toISOString()
      }),
      onChanged: noop
    },
    export: { choosePath: async () => null, start: async () => ({ jobId: '99999999-9999-4999-8999-999999999999', outputPaths: [] }) },
    recording: {
      state: async () => ({ target: 'song' as const, phase: 'idle' as const, sessionId: null, songId: null, recordingTrackId: null, sourcePositionMs: 0, countInRemaining: 0, sampleRate: 0, bufferFrames: 0, latencyMs: 0, xruns: 0, splitDevices: false, message: '', error: null }),
      devices: async () => [], startTest: async () => undefined, stopTest: async () => undefined,
      start: async () => ({ sessionId: '99999999-9999-4999-8999-999999999999' }), stop: async () => null, cancel: async () => undefined,
      updateTake: async () => { throw new Error('RECORDING_TAKE_NOT_FOUND') }, deleteTake: async () => undefined, selectTake: async () => undefined,
      createTrack: async (songId) => createDefaultRecordingTrackState(songId, '88888888-8888-4888-8888-888888888888'),
      updateTrack: async ({ recordingTrackId }) => createDefaultRecordingTrackState('11111111-1111-4111-8111-111111111111', recordingTrackId),
      onState: noop, onMeter: noop
    },
    rehearsals: {
      list: async () => [{
        id: rehearsal.id,
        name: rehearsal.name,
        itemCount: rehearsal.items.length,
        songCount: rehearsal.items.filter((item) => item.kind === 'song').length,
        createdAt: rehearsal.createdAt,
        updatedAt: rehearsal.updatedAt,
        lastOpenedAt: rehearsal.lastOpenedAt
      }],
      get: async (id) => id === rehearsal.id ? structuredClone(rehearsal) : null,
      create: async (name) => {
        rehearsal = {
          ...structuredClone(fixtureRehearsal),
          id: crypto.randomUUID(),
          name: name || '新排练编排',
          items: [],
          itemCount: 0,
          songCount: 0,
          recordingTracks: [],
          recordingTakes: [],
          revisions: []
        }
        return structuredClone(rehearsal)
      },
      save: async (request) => {
        rehearsal = {
          ...rehearsal,
          name: request.name,
          items: structuredClone(request.items),
          itemCount: request.items.length,
          songCount: request.items.filter((item) => item.kind === 'song').length,
          updatedAt: new Date().toISOString()
        }
        return structuredClone(rehearsal)
      },
      duplicate: async () => {
        rehearsal = {
          ...structuredClone(rehearsal),
          id: crypto.randomUUID(),
          name: `${rehearsal.name} 副本`,
          items: rehearsal.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
          recordingTracks: [],
          recordingTakes: [],
          revisions: []
        } satisfies RehearsalSetDetail
        return structuredClone(rehearsal)
      },
      delete: async () => undefined,
      createTrack: async (rehearsalId) => {
        const now = new Date().toISOString()
        const track = {
          id: crypto.randomUUID(), rehearsalId, name: `录音轨 ${rehearsal.recordingTracks.length + 1}`,
          activeTakeId: null, gainDb: 0, muted: false, solo: false,
          sortOrder: rehearsal.recordingTracks.length, createdAt: now, updatedAt: now
        }
        rehearsal = { ...rehearsal, recordingTracks: [...rehearsal.recordingTracks, track] }
        return structuredClone(track)
      },
      updateTrack: async ({ recordingTrackId, patch }) => {
        const current = rehearsal.recordingTracks.find((track) => track.id === recordingTrackId)
        if (!current) throw new Error('REHEARSAL_RECORDING_TRACK_NOT_FOUND')
        const updated = { ...current, ...patch, updatedAt: new Date().toISOString() }
        rehearsal = {
          ...rehearsal,
          recordingTracks: rehearsal.recordingTracks.map((track) => track.id === recordingTrackId ? updated : track)
        }
        return structuredClone(updated)
      },
      selectTake: async ({ recordingTrackId, takeId }) => {
        rehearsal = {
          ...rehearsal,
          recordingTracks: rehearsal.recordingTracks.map((track) => track.id === recordingTrackId
            ? { ...track, activeTakeId: takeId }
            : track)
        }
      },
      updateTake: async () => { throw new Error('REHEARSAL_RECORDING_TAKE_NOT_FOUND') },
      deleteTake: async () => undefined,
      recordingState: async () => rehearsalIdle(),
      startRecording: async () => ({ sessionId: crypto.randomUUID() }),
      pauseRecording: async () => undefined,
      resumeRecording: async () => undefined,
      stopRecording: async () => null,
      cancelRecording: async () => undefined,
      onChanged: noop,
      onRecordingState: noop,
      onMeter: noop
    },
    desktopLyrics: { setVisible: async () => undefined, update: () => undefined },
    window: { minimize: async () => undefined, toggleMaximize: async () => false, isMaximized: async () => false, close: async () => undefined, onHidden: noop, onMaximizedChange: noop }
  }
  window.bandbuddy = api
}
