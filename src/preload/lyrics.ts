import { IPC } from '@shared/channels.js'
import { normalizeAppearance, type Appearance } from '@shared/appearance.js'
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopLyricsRendererApi } from '@shared/bridge.js'
import type { DesktopLyricsPayload } from '@shared/domain.js'

const DESKTOP_LYRICS_UPDATE_EVENT = 'event:desktop-lyrics-update'

let latestAppearance = (() => {
  try { return normalizeAppearance(JSON.parse(decodeURIComponent(process.argv.find(value => value.startsWith('--bandbuddy-appearance='))?.split('=').slice(1).join('=') ?? 'null'))) }
  catch { return normalizeAppearance(null) }
})()
const appearanceListeners = new Set<(appearance: Appearance) => void>()
// Subscribe before exposing the bridge: renderer initialization may occur after
// a theme broadcast, and reloading creates a fresh preload with older argv.
ipcRenderer.on(IPC.eventAppearanceChanged, (_event, value: unknown) => {
  latestAppearance = normalizeAppearance(value)
  for (const listener of appearanceListeners) listener({ ...latestAppearance })
})
const api: DesktopLyricsRendererApi = {
  appearance: {
    get: async () => ({ ...latestAppearance }),
    onChanged(callback) {
      appearanceListeners.add(callback)
      return () => appearanceListeners.delete(callback)
    }
  },
  onUpdate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: DesktopLyricsPayload): void => callback(payload)
    ipcRenderer.on(DESKTOP_LYRICS_UPDATE_EVENT, listener)
    return () => ipcRenderer.removeListener(DESKTOP_LYRICS_UPDATE_EVENT, listener)
  }
}

contextBridge.exposeInMainWorld('desktopLyrics', api)
