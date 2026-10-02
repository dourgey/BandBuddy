import type {
  AppSettings,
  AudioBackend,
  RecordingAudioSettings,
  RecordingDeviceInfo
} from '@shared/domain.js'
import type { BandBuddyApi } from '@shared/bridge.js'

type ConcreteAudioBackend = Exclude<AudioBackend, 'auto'>

function bandbuddyApi(): BandBuddyApi {
  return (window as unknown as { bandbuddy: BandBuddyApi }).bandbuddy
}

export interface AudioDeviceSnapshot {
  playbackOutputDeviceIds: ReadonlySet<string> | null
  recordingDevices: readonly RecordingDeviceInfo[] | null
  platform: string
}

function automaticRecordingBackend(platform: string): ConcreteAudioBackend {
  return /Mac|iPhone|iPad/i.test(platform) ? 'coreaudio' : 'wasapi-shared'
}

function sameChannels(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((channel, index) => channel === right[index])
}

function defaultInput(devices: readonly RecordingDeviceInfo[]): RecordingDeviceInfo | undefined {
  return devices.find((device) => device.defaultInput && device.inputChannels > 0)
    ?? devices.find((device) => device.inputChannels > 0)
}

function defaultOutput(devices: readonly RecordingDeviceInfo[]): RecordingDeviceInfo | undefined {
  return devices.find((device) => device.defaultOutput && device.outputChannels > 0)
    ?? devices.find((device) => device.outputChannels > 0)
}

function reconcileRecordingAudio(
  current: RecordingAudioSettings,
  devices: readonly RecordingDeviceInfo[],
  platform: string
): RecordingAudioSettings {
  const automaticBackend = automaticRecordingBackend(platform)
  let backend = current.backend
  let resolvedBackend: ConcreteAudioBackend = backend === 'auto' ? automaticBackend : backend
  let backendDevices = devices.filter((device) => device.backend === resolvedBackend)

  if (backend !== 'auto' && (!defaultInput(backendDevices) || !defaultOutput(backendDevices))) {
    backend = 'auto'
    resolvedBackend = automaticBackend
    backendDevices = devices.filter((device) => device.backend === resolvedBackend)
  }

  const selectedInput = backendDevices.find((device) =>
    device.id === current.inputDeviceId && device.inputChannels > 0)
  const selectedOutput = backendDevices.find((device) =>
    device.id === current.outputDeviceId && device.outputChannels > 0)
  const inputDeviceId = current.inputDeviceId && selectedInput ? current.inputDeviceId : ''
  const outputDeviceId = current.outputDeviceId && selectedOutput ? current.outputDeviceId : ''
  const input = selectedInput ?? defaultInput(backendDevices)
  const output = selectedOutput ?? defaultOutput(backendDevices)

  let inputChannelMode = current.inputChannelMode
  if (inputChannelMode === 'stereo' && input && input.inputChannels < 2) inputChannelMode = 'mono'
  const requiredChannels = inputChannelMode === 'mono' ? 1 : 2
  const channelsValid = Boolean(input)
    && current.inputChannels.length === requiredChannels
    && current.inputChannels.every((channel) => Number.isInteger(channel) && channel >= 0 && (!input || channel < input.inputChannels))
    && (requiredChannels === 1 || current.inputChannels[1] === current.inputChannels[0]! + 1)
  const inputChannels = channelsValid
    ? current.inputChannels
    : inputChannelMode === 'mono' ? [0] : [0, 1]

  let sampleRate = current.sampleRate
  if (sampleRate) {
    if (!input || !output) sampleRate = 0
    else if (input.sampleRates.length > 0 && output.sampleRates.length > 0
      && (!input.sampleRates.includes(sampleRate) || !output.sampleRates.includes(sampleRate))) sampleRate = 0
  }

  const selectionChanged = backend !== current.backend
    || inputDeviceId !== current.inputDeviceId
    || outputDeviceId !== current.outputDeviceId
  const alignmentKey = `${resolvedBackend}|${inputDeviceId || 'default'}|${outputDeviceId || 'default'}`
  const alignmentOffsetMs = selectionChanged
    ? current.deviceAlignmentOffsets[alignmentKey] ?? 0
    : current.alignmentOffsetMs

  if (
    backend === current.backend
    && inputDeviceId === current.inputDeviceId
    && outputDeviceId === current.outputDeviceId
    && inputChannelMode === current.inputChannelMode
    && sameChannels(inputChannels, current.inputChannels)
    && sampleRate === current.sampleRate
    && alignmentOffsetMs === current.alignmentOffsetMs
  ) return current

  return {
    ...current,
    backend,
    inputDeviceId,
    outputDeviceId,
    inputChannelMode,
    inputChannels,
    sampleRate,
    alignmentOffsetMs
  }
}

export function reconcileAudioDeviceSettings(
  settings: AppSettings,
  snapshot: AudioDeviceSnapshot
): AppSettings {
  const audioOutputDeviceId = snapshot.playbackOutputDeviceIds !== null
    && settings.audioOutputDeviceId
    && !snapshot.playbackOutputDeviceIds.has(settings.audioOutputDeviceId)
    ? ''
    : settings.audioOutputDeviceId
  const recordingAudio = snapshot.recordingDevices === null
    ? settings.recordingAudio
    : reconcileRecordingAudio(settings.recordingAudio, snapshot.recordingDevices, snapshot.platform)

  if (audioOutputDeviceId === settings.audioOutputDeviceId && recordingAudio === settings.recordingAudio) return settings
  return { ...settings, audioOutputDeviceId, recordingAudio }
}

async function enumeratePlaybackOutputDeviceIds(): Promise<ReadonlySet<string> | null> {
  if (!navigator.mediaDevices?.enumerateDevices) return null
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return new Set(devices.filter((device) => device.kind === 'audiooutput').map((device) => device.deviceId))
  } catch {
    return null
  }
}

async function enumerateRecordingDevices(): Promise<readonly RecordingDeviceInfo[] | null> {
  try {
    return await bandbuddyApi().recording.devices()
  } catch {
    return null
  }
}

/** Reads persisted preferences immediately; hardware enumeration is deliberately separate. */
export function loadStartupAudioSettings(): Promise<AppSettings> {
  return bandbuddyApi().settings.get()
}

/** The main process compares the audio snapshot before merging, so new preferences cannot be overwritten. */
export async function reconcileStartupAudioSettings(settings: AppSettings, canApply: () => boolean = () => true): Promise<AppSettings> {
  const [playbackOutputDeviceIds, recordingDevices] = await Promise.all([
    enumeratePlaybackOutputDeviceIds(),
    enumerateRecordingDevices()
  ])
  const reconciled = reconcileAudioDeviceSettings(settings, { playbackOutputDeviceIds, recordingDevices, platform: navigator.platform })
  if (reconciled === settings || !canApply()) return settings
  return bandbuddyApi().settings.reconcileAudio({
    expected: { audioOutputDeviceId: settings.audioOutputDeviceId, recordingAudio: settings.recordingAudio },
    audioOutputDeviceId: reconciled.audioOutputDeviceId,
    recordingAudio: reconciled.recordingAudio
  })
}
