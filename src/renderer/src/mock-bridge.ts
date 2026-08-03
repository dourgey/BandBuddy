import type { BandBuddyApi } from '@shared/bridge.js'
import { createDefaultRecordingAudioSettings, createDefaultRecordingTrackState } from '@shared/domain.js'
import type { RehearsalRecordingState, RehearsalSetDetail } from '@shared/rehearsal.js'
import { fixtureDetail, fixtureRehearsal, fixtureSongs } from './fixtures.js'

const noop = (): (() => void) => () => undefined

export function installFixtureBridge(): void {
  if (window.bandbuddy) return
  const settings = {
    libraryRoot: 'C:\\Users\\Musician\\BandBuddy\\music',
    runtimeRoot: 'C:\\Users\\Musician\\BandBuddy\\envs',
    modelRoot: 'C:\\Users\\Musician\\BandBuddy\\envs\\models',
    preferredDevice: 'auto' as const,
    audioOutputDeviceId: '', latencyMode: 'balanced' as const, recordingAudio: createDefaultRecordingAudioSettings(), keepSource: true, closeToTrayWhileWorking: true,
    network: {
      proxyMode: 'system' as const,
      proxyUrl: '',
      pythonInstallMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone/',
      pythonIndexUrl: 'https://mirrors.aliyun.com/pypi/simple',
      pytorchIndexUrl: 'https://mirrors.aliyun.com/pytorch-wheels/{backend}/',
      modelBaseUrl: 'https://modelscope.cn/models/pengzhendong/uvr-demucs/resolve/6938a11d024a7fffa0d9c09e79b1ba2cbcb13239/v3_v4_repo/'
    }
  }
  const runtime = {
    status: 'ready' as const, stage: '环境就绪 · CUDA', progress: 1, device: 'auto' as const, selectedDevice: 'cuda' as const,
    gpu: { name: 'NVIDIA GeForce RTX 4070', driverVersion: '590.18', memoryMb: 12282 },
    pythonVersion: '3.12.10', torchVersion: '2.11.0+cu130', cudaVersion: '13.0', demucsVersion: '4.1.0', modelReady: true,
    modelRevision: 'htdemucs_6s:5c90dfd2-34c22ccb', runtimePath: settings.runtimeRoot, modelPath: settings.modelRoot, error: null
  }
  let rehearsal = structuredClone(fixtureRehearsal)
  const rehearsalIdle = (): RehearsalRecordingState => ({
    target: 'rehearsal',
    phase: 'idle', sessionId: null, rehearsalId: null, recordingTrackId: null, revisionId: null,
    timelineFingerprint: null, timelinePositionMs: 0, preRollRemaining: 0, sampleRate: 0,
    bufferFrames: 0, latencyMs: 0, xruns: 0, splitDevices: false, message: '', error: null
  })
  const api: BandBuddyApi = {
    library: {
      list: async () => fixtureSongs,
      get: async (id) => { const song = fixtureSongs.find((item) => item.id === id); return song ? fixtureDetail(song) : null },
      chooseSource: async () => null, chooseStems: async () => [],
      importSource: async () => ({ songId: null, jobId: null, duplicate: null, needsPadding: false, durationDifferenceMs: 0, warnings: [] }),
      importStems: async () => ({ songId: null, jobId: null, duplicate: null, needsPadding: false, durationDifferenceMs: 0, warnings: [] }),
      importLyrics: async (id) => { const song = fixtureSongs.find((item) => item.id === id); return song ? fixtureDetail(song) : null },
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
    window: { minimize: async () => undefined, toggleMaximize: async () => false, close: async () => undefined, onHidden: noop }
  }
  window.bandbuddy = api
}
