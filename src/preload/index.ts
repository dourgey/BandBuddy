import { ARSENAL_CHANNEL, ARSENAL_MONITOR_EVENT } from '@shared/arsenal.js'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BandBuddyApi } from '@shared/bridge.js'
import { IPC } from '@shared/channels.js'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BandBuddyApi = {
  arsenal: {
    list: () => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'list' }),
    importAsset: (kind, sampleRate) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'import', kind, sampleRate }),
    deleteAsset: (id) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'deleteAsset', id }),
    savePreset: (input) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'save', ...input }),
    deletePreset: (id) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'delete', id }),
    setTrack: (input) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'track', ...input }),
    prepare: (chain) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'prepare', chain }),
    monitor: (input) => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'monitor', ...input }),
    monitorState: () => ipcRenderer.invoke(ARSENAL_CHANNEL, { op: 'state' }),
    onMonitor: (callback) => subscribe(ARSENAL_MONITOR_EVENT, callback)
  },
  library: {
    list: (input = {}) => ipcRenderer.invoke(IPC.libraryList, input),
    get: (songId) => ipcRenderer.invoke(IPC.libraryGet, songId),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    chooseStems: (mode) => ipcRenderer.invoke(IPC.libraryChooseStems, mode),
    importStems: (options) => ipcRenderer.invoke(IPC.libraryImportStems, options),
    chooseSource: () => ipcRenderer.invoke(IPC.libraryChooseSource),
    importSource: (options) => ipcRenderer.invoke(IPC.libraryImportSource, options),
    importLyrics: (songId) => ipcRenderer.invoke(IPC.libraryImportLyrics, songId),
    update: (input) => ipcRenderer.invoke(IPC.libraryUpdate, input),
    delete: (songId) => ipcRenderer.invoke(IPC.libraryDelete, songId),
    openLocation: (songId) => ipcRenderer.invoke(IPC.libraryOpenLocation, songId),
    reSeparate: (songId) => ipcRenderer.invoke(IPC.libraryReseparate, songId),
    requestGuitarSplit: (songId) => ipcRenderer.invoke(IPC.libraryRequestGuitarSplit, songId),
    savePractice: (state) => ipcRenderer.invoke(IPC.practiceSave, state),
    onChanged: (callback) => subscribe<void>(IPC.eventLibraryChanged, callback),
    onGuitarSplitCompleted: (callback) => subscribe<string>(IPC.eventGuitarSplitCompleted, callback)
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC.tasksList),
    cancel: (jobId) => ipcRenderer.invoke(IPC.tasksCancel, jobId),
    retry: (jobId, useCpu = false) => ipcRenderer.invoke(IPC.tasksRetry, { jobId, useCpu }),
    clearFinished: () => ipcRenderer.invoke(IPC.tasksClear),
    onChanged: (callback) => subscribe<void>(IPC.eventTasksChanged, callback)
  },
  runtime: {
    get: () => ipcRenderer.invoke(IPC.runtimeGet),
    detect: () => ipcRenderer.invoke(IPC.runtimeDetect),
    install: () => ipcRenderer.invoke(IPC.runtimeInstall),
    cancel: () => ipcRenderer.invoke(IPC.runtimeCancel),
    repair: () => ipcRenderer.invoke(IPC.runtimeRepair),
    remove: (includeModels = false) => ipcRenderer.invoke(IPC.runtimeRemove, includeModels),
    clearModel: () => ipcRenderer.invoke(IPC.runtimeClearModel),
    onChanged: (callback) => subscribe(IPC.eventRuntimeChanged, callback)
  },
  lan: {
    status: () => ipcRenderer.invoke(IPC.lanStatus),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC.lanSetEnabled, enabled)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    chooseDataRoot: (currentLibraryRoot) => ipcRenderer.invoke(IPC.settingsChooseDataRoot, currentLibraryRoot),
    update: (settings) => ipcRenderer.invoke(IPC.settingsUpdate, settings),
    setDebugMode: (enabled) => ipcRenderer.invoke(IPC.settingsSetDebugMode, enabled),
    revealDebugLog: () => ipcRenderer.invoke(IPC.settingsRevealDebugLog),
    onChanged: (callback) => subscribe(IPC.eventSettingsChanged, callback)
  },
  media: {
    prepareOutputDevice: (deviceName) => ipcRenderer.invoke(IPC.mediaPrepareOutputDevice, deviceName),
    capabilities: () => ipcRenderer.invoke(IPC.mediaCapabilities),
    detectBpm: (songId) => ipcRenderer.invoke(IPC.mediaDetectBpm, songId),
    detectKey: (songId) => ipcRenderer.invoke(IPC.mediaDetectKey, songId),
    onChanged: (callback) => subscribe(IPC.eventMediaChanged, callback)
  },
  export: {
    choosePath: (kind, format, songTitle) => ipcRenderer.invoke(IPC.exportChoosePath, { kind, format, songTitle }),
    start: (request) => ipcRenderer.invoke(IPC.exportStart, request)
  },
  recording: {
    state: () => ipcRenderer.invoke(IPC.recordingGetState),
    devices: () => ipcRenderer.invoke(IPC.recordingDevices),
    startTest: () => ipcRenderer.invoke(IPC.recordingStartTest),
    stopTest: () => ipcRenderer.invoke(IPC.recordingStopTest),
    start: (request) => ipcRenderer.invoke(IPC.recordingStart, request),
    stop: () => ipcRenderer.invoke(IPC.recordingStop),
    cancel: () => ipcRenderer.invoke(IPC.recordingCancel),
    updateTake: (input) => ipcRenderer.invoke(IPC.recordingUpdateTake, input),
    deleteTake: (takeId) => ipcRenderer.invoke(IPC.recordingDeleteTake, takeId),
    selectTake: (input) => ipcRenderer.invoke(IPC.recordingSelectTake, input),
    createTrack: (songId) => ipcRenderer.invoke(IPC.recordingCreateTrack, songId),
    updateTrack: (input) => ipcRenderer.invoke(IPC.recordingUpdateTrack, input),
    onState: (callback) => subscribe(IPC.eventRecordingState, callback),
    onMeter: (callback) => subscribe(IPC.eventRecordingMeter, callback)
  },
  rehearsals: {
    list: () => ipcRenderer.invoke(IPC.rehearsalList),
    get: (rehearsalId) => ipcRenderer.invoke(IPC.rehearsalGet, rehearsalId),
    create: (name) => ipcRenderer.invoke(IPC.rehearsalCreate, name),
    save: (request) => ipcRenderer.invoke(IPC.rehearsalSave, request),
    duplicate: (input) => ipcRenderer.invoke(IPC.rehearsalDuplicate, input),
    delete: (rehearsalId) => ipcRenderer.invoke(IPC.rehearsalDelete, rehearsalId),
    createTrack: (rehearsalId) => ipcRenderer.invoke(IPC.rehearsalRecordingCreateTrack, rehearsalId),
    updateTrack: (input) => ipcRenderer.invoke(IPC.rehearsalRecordingUpdateTrack, input),
    selectTake: (input) => ipcRenderer.invoke(IPC.rehearsalRecordingSelectTake, input),
    updateTake: (input) => ipcRenderer.invoke(IPC.rehearsalRecordingUpdateTake, input),
    deleteTake: (takeId) => ipcRenderer.invoke(IPC.rehearsalRecordingDeleteTake, takeId),
    recordingState: () => ipcRenderer.invoke(IPC.rehearsalRecordingGetState),
    startRecording: (request) => ipcRenderer.invoke(IPC.rehearsalRecordingStart, request),
    pauseRecording: () => ipcRenderer.invoke(IPC.rehearsalRecordingPause),
    resumeRecording: () => ipcRenderer.invoke(IPC.rehearsalRecordingResume),
    stopRecording: () => ipcRenderer.invoke(IPC.rehearsalRecordingStop),
    cancelRecording: () => ipcRenderer.invoke(IPC.rehearsalRecordingCancel),
    onChanged: (callback) => subscribe<void>(IPC.eventRehearsalsChanged, callback),
    onRecordingState: (callback) => subscribe(IPC.eventRehearsalRecordingState, callback),
    onMeter: (callback) => subscribe(IPC.eventRehearsalRecordingMeter, callback)
  },
  desktopLyrics: {
    setVisible: (visible) => ipcRenderer.invoke(IPC.desktopLyricsSetVisible, visible),
    update: (payload) => ipcRenderer.send(IPC.desktopLyricsUpdate, payload)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    onHidden: (callback) => subscribe<void>(IPC.eventWindowHidden, callback),
    onMaximizedChange: (callback) => subscribe<boolean>(IPC.eventWindowMaximizedChanged, callback)
  }
}

contextBridge.exposeInMainWorld('bandbuddy', api)
