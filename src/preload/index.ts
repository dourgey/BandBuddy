import { normalizeAppearance, resolveTheme } from '@shared/appearance.js'
import type { StartupState } from '@shared/startup.js'
import { ARSENAL_CHANNEL, ARSENAL_MONITOR_EVENT } from '@shared/arsenal.js'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BandBuddyApi } from '@shared/bridge.js'
import type { JobRecord } from '@shared/domain.js'
import { IPC } from '@shared/channels.js'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

let startupState: StartupState = ipcRenderer.sendSync(IPC.startupSnapshot) ?? {
  phase: 'failed', appearance: normalizeAppearance(null), message: '无法连接启动服务，请重新打开应用。'
}
const startupListeners = new Set<(state: StartupState) => void>()
const serviceWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()
const paintInitialTheme = (): void => {
  const root = document.documentElement
  if (!root) return
  const appearance = normalizeAppearance(startupState.appearance)
  root.dataset.theme = resolveTheme(appearance, matchMedia('(prefers-color-scheme: dark)').matches)
  root.dataset.themeMode = appearance.theme
  root.dataset.density = appearance.density
  root.dataset.effects = appearance.effects
  root.style.colorScheme = root.dataset.theme === 'dark' ? 'dark' : 'light'
}
if (document.documentElement) paintInitialTheme()
else {
  const observer = new MutationObserver(() => { if (document.documentElement) { paintInitialTheme(); observer.disconnect() } })
  observer.observe(document, { childList: true })
}
ipcRenderer.on(IPC.eventStartupChanged, (_event, state: StartupState) => {
  startupState = state
  if (state.phase !== 'ready') paintInitialTheme()
  for (const listener of startupListeners) listener(state)
  if (state.phase === 'ready' || state.phase === 'failed') {
    for (const waiter of serviceWaiters) {
      if (state.phase === 'ready') waiter.resolve()
      else waiter.reject(new Error(state.error ?? state.message))
    }
    serviceWaiters.clear()
  }
})
const windowChannels = new Set<string>([IPC.windowMinimize, IPC.windowClose, IPC.windowIsMaximized, IPC.windowToggleMaximize])
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  if (!windowChannels.has(channel)) {
    if (startupState.phase === 'failed') throw new Error(startupState.error ?? startupState.message)
    if (startupState.phase !== 'ready') await new Promise<void>((resolve, reject) => serviceWaiters.add({ resolve, reject }))
  }
  return ipcRenderer.invoke(channel, ...args)
}

const api: BandBuddyApi = {
  startup: {
    snapshot: () => startupState,
    get: () => ipcRenderer.invoke(IPC.startupGet),
    onChanged: callback => { startupListeners.add(callback); return () => { startupListeners.delete(callback) } },
    painted: () => ipcRenderer.invoke(IPC.startupPainted)
  },
  appearance: {
    get: () => invoke(IPC.appearanceGet),
    set: (value) => invoke(IPC.appearanceSet, value),
    onChanged: (callback) => subscribe(IPC.eventAppearanceChanged, callback)
  },
  arsenal: {
    list: () => invoke(ARSENAL_CHANNEL, { op: 'list' }),
    importAsset: (kind, sampleRate) => invoke(ARSENAL_CHANNEL, { op: 'import', kind, sampleRate }),
    deleteAsset: (id) => invoke(ARSENAL_CHANNEL, { op: 'deleteAsset', id }),
    savePreset: (input) => invoke(ARSENAL_CHANNEL, { op: 'save', ...input }),
    deletePreset: (id) => invoke(ARSENAL_CHANNEL, { op: 'delete', id }),
    setTrack: (input) => invoke(ARSENAL_CHANNEL, { op: 'track', ...input }),
    prepare: (chain) => invoke(ARSENAL_CHANNEL, { op: 'prepare', chain }),
    monitor: (input) => invoke(ARSENAL_CHANNEL, { op: 'monitor', ...input }),
    monitorState: () => invoke(ARSENAL_CHANNEL, { op: 'state' }),
    onMonitor: (callback) => subscribe(ARSENAL_MONITOR_EVENT, callback)
  },
  library: {
    listPage: (input = {}) => invoke(IPC.libraryListPage, input),
    onUpdated: (callback) => subscribe(IPC.eventLibraryUpdated, callback),
    list: (input = {}) => invoke(IPC.libraryList, input),
    get: (songId) => invoke(IPC.libraryGet, songId),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    chooseStems: (mode) => invoke(IPC.libraryChooseStems, mode),
    importStems: (options) => invoke(IPC.libraryImportStems, options),
    chooseSource: () => invoke(IPC.libraryChooseSource),
    importSource: (options) => invoke(IPC.libraryImportSource, options),
    importLyrics: (songId) => invoke(IPC.libraryImportLyrics, songId),
    update: (input) => invoke(IPC.libraryUpdate, input),
    delete: (songId) => invoke(IPC.libraryDelete, songId),
    openLocation: (songId) => invoke(IPC.libraryOpenLocation, songId),
    reSeparate: (songId) => invoke(IPC.libraryReseparate, songId),
    requestGuitarSplit: (songId) => invoke(IPC.libraryRequestGuitarSplit, songId),
    savePractice: (state) => invoke(IPC.practiceSave, state),
    onChanged: (callback) => subscribe<void>(IPC.eventLibraryChanged, callback),
    onGuitarSplitCompleted: (callback) => subscribe<string>(IPC.eventGuitarSplitCompleted, callback)
  },
  tasks: {
    list: () => invoke(IPC.tasksList),
    cancel: (jobId) => invoke(IPC.tasksCancel, jobId),
    retry: (jobId, useCpu = false) => invoke(IPC.tasksRetry, { jobId, useCpu }),
    clearFinished: () => invoke(IPC.tasksClear),
    onChanged: (callback) => subscribe<JobRecord | undefined>(IPC.eventTasksChanged, callback)
  },
  runtime: {
    get: () => invoke(IPC.runtimeGet),
    detect: () => invoke(IPC.runtimeDetect),
    install: () => invoke(IPC.runtimeInstall),
    cancel: () => invoke(IPC.runtimeCancel),
    repair: () => invoke(IPC.runtimeRepair),
    remove: (includeModels = false) => invoke(IPC.runtimeRemove, includeModels),
    clearModel: () => invoke(IPC.runtimeClearModel),
    onChanged: (callback) => subscribe(IPC.eventRuntimeChanged, callback)
  },
  lan: {
    status: () => invoke(IPC.lanStatus),
    setEnabled: (enabled) => invoke(IPC.lanSetEnabled, enabled)
  },
  settings: {
    reconcileAudio: (input) => invoke(IPC.settingsReconcileAudio, input),
    get: () => invoke(IPC.settingsGet),
    chooseDataRoot: (currentLibraryRoot) => invoke(IPC.settingsChooseDataRoot, currentLibraryRoot),
    update: (settings) => invoke(IPC.settingsUpdate, settings),
    setDebugMode: (enabled) => invoke(IPC.settingsSetDebugMode, enabled),
    revealDebugLog: () => invoke(IPC.settingsRevealDebugLog),
    onChanged: (callback) => subscribe(IPC.eventSettingsChanged, callback)
  },
  media: {
    prepareOutputDevice: (deviceName) => invoke(IPC.mediaPrepareOutputDevice, deviceName),
    capabilities: () => invoke(IPC.mediaCapabilities),
    detectBpm: (songId) => invoke(IPC.mediaDetectBpm, songId),
    detectKey: (songId) => invoke(IPC.mediaDetectKey, songId),
    onChanged: (callback) => subscribe(IPC.eventMediaChanged, callback)
  },
  export: {
    choosePath: (kind, format, songTitle) => invoke(IPC.exportChoosePath, { kind, format, songTitle }),
    start: (request) => invoke(IPC.exportStart, request)
  },
  recording: {
    state: () => invoke(IPC.recordingGetState),
    devices: () => invoke(IPC.recordingDevices),
    startTest: () => invoke(IPC.recordingStartTest),
    stopTest: () => invoke(IPC.recordingStopTest),
    start: (request) => invoke(IPC.recordingStart, request),
    stop: () => invoke(IPC.recordingStop),
    cancel: () => invoke(IPC.recordingCancel),
    updateTake: (input) => invoke(IPC.recordingUpdateTake, input),
    deleteTake: (takeId) => invoke(IPC.recordingDeleteTake, takeId),
    selectTake: (input) => invoke(IPC.recordingSelectTake, input),
    createTrack: (songId) => invoke(IPC.recordingCreateTrack, songId),
    updateTrack: (input) => invoke(IPC.recordingUpdateTrack, input),
    onState: (callback) => subscribe(IPC.eventRecordingState, callback),
    onMeter: (callback) => subscribe(IPC.eventRecordingMeter, callback)
  },
  rehearsals: {
    list: () => invoke(IPC.rehearsalList),
    get: (rehearsalId) => invoke(IPC.rehearsalGet, rehearsalId),
    create: (name) => invoke(IPC.rehearsalCreate, name),
    save: (request) => invoke(IPC.rehearsalSave, request),
    duplicate: (input) => invoke(IPC.rehearsalDuplicate, input),
    delete: (rehearsalId) => invoke(IPC.rehearsalDelete, rehearsalId),
    createTrack: (rehearsalId) => invoke(IPC.rehearsalRecordingCreateTrack, rehearsalId),
    updateTrack: (input) => invoke(IPC.rehearsalRecordingUpdateTrack, input),
    selectTake: (input) => invoke(IPC.rehearsalRecordingSelectTake, input),
    updateTake: (input) => invoke(IPC.rehearsalRecordingUpdateTake, input),
    deleteTake: (takeId) => invoke(IPC.rehearsalRecordingDeleteTake, takeId),
    recordingState: () => invoke(IPC.rehearsalRecordingGetState),
    startRecording: (request) => invoke(IPC.rehearsalRecordingStart, request),
    pauseRecording: () => invoke(IPC.rehearsalRecordingPause),
    resumeRecording: () => invoke(IPC.rehearsalRecordingResume),
    stopRecording: () => invoke(IPC.rehearsalRecordingStop),
    cancelRecording: () => invoke(IPC.rehearsalRecordingCancel),
    onChanged: (callback) => subscribe<void>(IPC.eventRehearsalsChanged, callback),
    onRecordingState: (callback) => subscribe(IPC.eventRehearsalRecordingState, callback),
    onMeter: (callback) => subscribe(IPC.eventRehearsalRecordingMeter, callback)
  },
  desktopLyrics: {
    setVisible: (visible) => invoke(IPC.desktopLyricsSetVisible, visible),
    update: (payload) => ipcRenderer.send(IPC.desktopLyricsUpdate, payload)
  },
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    isMaximized: () => invoke(IPC.windowIsMaximized),
    close: () => invoke(IPC.windowClose),
    onHidden: (callback) => subscribe<void>(IPC.eventWindowHidden, callback),
    onMaximizedChange: (callback) => subscribe<boolean>(IPC.eventWindowMaximizedChanged, callback)
  }
}

contextBridge.exposeInMainWorld('bandbuddy', api)
