import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE } from '../packages/shared/src/appearance.js'
import {
  createDefaultRecordingAudioSettings,
  type AppSettings,
  type RecordingDeviceInfo
} from '../packages/shared/src/domain.js'
import {
  loadStartupAudioSettings,
  reconcileStartupAudioSettings,
  reconcileAudioDeviceSettings
} from '../src/renderer/src/startup-audio-devices.js'

afterEach(() => vi.unstubAllGlobals())

function appSettings(): AppSettings {
  return {
    appearance: { ...DEFAULT_APPEARANCE },
    libraryRoot: 'music',
    runtimeRoot: 'runtime',
    modelRoot: 'models',
    debugMode: false,
    desktopLyricsFontSize: 24,
    desktopLyricsBackgroundTransparency: 20,
    highQualityStems: false,
    guitarSeparationQuality: 'balanced',
    preferredDevice: 'auto',
    audioOutputDeviceId: '',
    latencyMode: 'balanced',
    recordingAudio: createDefaultRecordingAudioSettings(),
    keepSource: true,
    closeToTrayWhileWorking: true,
    network: {
      proxyMode: 'system',
      proxyUrl: '',
      pythonInstallMirror: '',
      pythonIndexUrl: '',
      pytorchIndexUrl: ''
    }
  }
}

function device(patch: Partial<RecordingDeviceInfo> = {}): RecordingDeviceInfo {
  return {
    id: 'wasapi:realtek',
    backend: 'wasapi-shared',
    name: 'Realtek Audio',
    inputChannels: 2,
    outputChannels: 2,
    duplexChannels: 2,
    sampleRates: [44_100, 48_000],
    preferredSampleRate: 48_000,
    defaultInput: true,
    defaultOutput: true,
    ...patch
  }
}

describe('startup audio device reconciliation', () => {
  it('returns saved preferences without waiting for hardware or altering settings', async () => {
    const settings = appSettings()
    const devices = vi.fn(() => new Promise(() => {}))
    const reconcileAudio = vi.fn()
    vi.stubGlobal('window', { bandbuddy: { settings: { get: async () => settings, reconcileAudio }, recording: { devices } } })
    expect(await loadStartupAudioSettings()).toBe(settings)
    expect(devices).not.toHaveBeenCalled()
    expect(reconcileAudio).not.toHaveBeenCalled()
  })

  it('does not overwrite an explicit output after a background scan', async () => {
    const initial = appSettings()
    initial.audioOutputDeviceId = 'missing'
    const latest = { ...initial, libraryRoot: '用户新选择的目录', audioOutputDeviceId: 'new-device' }
    const reconcileAudio = vi.fn(async () => latest)
    vi.stubGlobal('window', { bandbuddy: { settings: { reconcileAudio }, recording: { devices: async () => [] } } })
    vi.stubGlobal('navigator', { platform: 'Win32', mediaDevices: { enumerateDevices: async () => [] } })
    expect(await reconcileStartupAudioSettings(initial)).toBe(initial)
    expect(reconcileAudio).not.toHaveBeenCalled()
  })

  it('refreshes hardware without substituting newly discovered microphones or speakers', async () => {
    let saved = appSettings()
    saved.audioOutputDeviceId = 'old-usb-web'
    saved.recordingAudio = {
      ...saved.recordingAudio,
      inputDeviceId: 'coreaudio:old-usb',
      outputDeviceId: 'coreaudio:old-usb'
    }
    const oldUsb = device({ id: 'coreaudio:old-usb', backend: 'coreaudio', name: 'USB Interface' })
    const builtIn = device({
      id: 'coreaudio:speakers', backend: 'coreaudio', name: 'Built-in Speakers',
      inputChannels: 0, defaultInput: false
    })
    const newVirtual = device({
      id: 'coreaudio:new-virtual', backend: 'coreaudio', name: 'Loopback Audio',
      inputChannels: 8, outputChannels: 8, defaultOutput: false
    })
    const recordingDevices = vi.fn()
      .mockResolvedValueOnce([oldUsb])
      .mockResolvedValueOnce([builtIn, newVirtual])
    const playbackDevices = vi.fn()
      .mockResolvedValueOnce([{ kind: 'audiooutput', deviceId: 'old-usb-web' }])
      .mockResolvedValueOnce([
        { kind: 'audiooutput', deviceId: 'built-in-web' },
        { kind: 'audiooutput', deviceId: 'new-loopback-web' }
      ])
    const update = vi.fn(async (settings: AppSettings) => { saved = settings; return settings })
    vi.stubGlobal('window', { bandbuddy: {
      settings: { get: async () => saved, update, reconcileAudio: async (request: { audioOutputDeviceId: string; recordingAudio: AppSettings['recordingAudio'] }) => update({ ...saved, audioOutputDeviceId: request.audioOutputDeviceId, recordingAudio: request.recordingAudio }) }, recording: { devices: recordingDevices }
    } })
    vi.stubGlobal('navigator', { platform: 'MacIntel', mediaDevices: { enumerateDevices: playbackDevices } })

    const firstLaunch = await reconcileStartupAudioSettings(await loadStartupAudioSettings())
    expect(firstLaunch.audioOutputDeviceId).toBe('old-usb-web')
    expect(update).not.toHaveBeenCalled()

    const secondLaunch = await reconcileStartupAudioSettings(await loadStartupAudioSettings())
    expect(playbackDevices).toHaveBeenCalledTimes(2)
    expect(recordingDevices).toHaveBeenCalledTimes(2)
    expect(secondLaunch.audioOutputDeviceId).toBe('old-usb-web')
    expect(secondLaunch.recordingAudio.inputDeviceId).toBe('coreaudio:old-usb')
    expect(secondLaunch.recordingAudio.outputDeviceId).toBe('coreaudio:old-usb')
    expect(update).not.toHaveBeenCalled()
  })

  it('does not force a newly discovered multichannel device over the system default', async () => {
    const settings = appSettings()
    const update = vi.fn()
    vi.stubGlobal('window', { bandbuddy: {
      settings: { get: async () => settings, update },
      recording: { devices: async () => [
        device({ backend: 'coreaudio' }),
        device({ id: 'coreaudio:loopback', backend: 'coreaudio', name: 'Loopback Audio',
          inputChannels: 16, outputChannels: 16, defaultInput: false, defaultOutput: false })
      ] }
    } })
    vi.stubGlobal('navigator', { platform: 'MacIntel', mediaDevices: { enumerateDevices: async () => [
      { kind: 'audiooutput', deviceId: 'default' },
      { kind: 'audiooutput', deviceId: 'loopback-web' }
    ] } })

    expect(await reconcileStartupAudioSettings(await loadStartupAudioSettings())).toBe(settings)
    expect(update).not.toHaveBeenCalled()
  })

  it('takes a new hardware snapshot each time the app startup loader runs', async () => {
    const getSettings = vi.fn(() => Promise.resolve(appSettings()))
    const updateSettings = vi.fn((settings: AppSettings) => Promise.resolve(settings))
    const recordingDevices = vi.fn(() => Promise.resolve([device()]))
    const playbackDevices = vi.fn(() => Promise.resolve([
      { kind: 'audiooutput', deviceId: 'default' }
    ]))
    vi.stubGlobal('window', {
      bandbuddy: {
        settings: { get: getSettings, update: updateSettings },
        recording: { devices: recordingDevices }
      }
    })
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      mediaDevices: { enumerateDevices: playbackDevices }
    })

    await reconcileStartupAudioSettings(await loadStartupAudioSettings())
    await reconcileStartupAudioSettings(await loadStartupAudioSettings())

    expect(getSettings).toHaveBeenCalledTimes(2)
    expect(recordingDevices).toHaveBeenCalledTimes(2)
    expect(playbackDevices).toHaveBeenCalledTimes(2)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('preserves disconnected explicit ASIO devices and their calibrated settings', () => {
    const settings = appSettings()
    settings.audioOutputDeviceId = 'disconnected-web-output'
    settings.recordingAudio = {
      ...settings.recordingAudio,
      backend: 'asio',
      inputDeviceId: 'asio:disconnected-input',
      outputDeviceId: 'asio:disconnected-output',
      inputChannelMode: 'stereo',
      inputChannels: [4, 5],
      sampleRate: 96_000,
      alignmentOffsetMs: 42,
      deviceAlignmentOffsets: { 'wasapi-shared|default|default': 7 }
    }

    const reconciled = reconcileAudioDeviceSettings(settings, {
      playbackOutputDeviceIds: new Set(['default', 'realtek-web-output']),
      recordingDevices: [device()],
      platform: 'Win32'
    })

    expect(reconciled).toBe(settings)
  })

  it('keeps explicit devices that are still available', () => {
    const settings = appSettings()
    settings.audioOutputDeviceId = 'usb-web-output'
    settings.recordingAudio = {
      ...settings.recordingAudio,
      backend: 'asio',
      inputDeviceId: 'asio:usb',
      outputDeviceId: 'asio:usb',
      inputChannelMode: 'stereo',
      inputChannels: [1, 2],
      sampleRate: 48_000
    }
    const usb = device({
      id: 'asio:usb',
      backend: 'asio',
      inputChannels: 4,
      outputChannels: 4
    })

    const reconciled = reconcileAudioDeviceSettings(settings, {
      playbackOutputDeviceIds: new Set(['usb-web-output']),
      recordingDevices: [usb],
      platform: 'Win32'
    })

    expect(reconciled).toBe(settings)
  })

  it('does not erase selections when either device scan itself failed', () => {
    const settings = appSettings()
    settings.audioOutputDeviceId = 'remembered-output'
    settings.recordingAudio = {
      ...settings.recordingAudio,
      backend: 'asio',
      inputDeviceId: 'remembered-input',
      outputDeviceId: 'remembered-recording-output'
    }

    const reconciled = reconcileAudioDeviceSettings(settings, {
      playbackOutputDeviceIds: null,
      recordingDevices: null,
      platform: 'Win32'
    })

    expect(reconciled).toBe(settings)
  })

  it('leaves an unusable explicit input for the user to change', () => {
    const settings = appSettings()
    settings.recordingAudio = {
      ...settings.recordingAudio,
      inputDeviceId: 'wasapi:output-only',
      outputDeviceId: 'wasapi:output-only'
    }
    const outputOnly = device({
      id: 'wasapi:output-only',
      inputChannels: 0,
      outputChannels: 2,
      defaultInput: false
    })

    const reconciled = reconcileAudioDeviceSettings(settings, {
      playbackOutputDeviceIds: new Set(),
      recordingDevices: [device(), outputOnly],
      platform: 'Win32'
    })

    expect(reconciled.recordingAudio.inputDeviceId).toBe('wasapi:output-only')
    expect(reconciled.recordingAudio.outputDeviceId).toBe('wasapi:output-only')
  })

  it('preserves device settings while hardware is disconnected', () => {
    const settings = appSettings()
    settings.recordingAudio = {
      ...settings.recordingAudio,
      backend: 'asio',
      inputDeviceId: 'asio:0:old-interface',
      outputDeviceId: 'asio:0:old-interface',
      inputChannelMode: 'stereo',
      inputChannels: [6, 7],
      sampleRate: 96_000
    }

    const reconciled = reconcileAudioDeviceSettings(settings, {
      playbackOutputDeviceIds: new Set(),
      recordingDevices: [],
      platform: 'Win32'
    })

    expect(reconciled).toBe(settings)
  })
})
