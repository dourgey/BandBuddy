import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopLyricsRendererApi } from '@shared/bridge.js'
import type { DesktopLyricsPayload } from '@shared/domain.js'

const DESKTOP_LYRICS_UPDATE_EVENT = 'event:desktop-lyrics-update'

const api: DesktopLyricsRendererApi = {
  onUpdate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: DesktopLyricsPayload): void => callback(payload)
    ipcRenderer.on(DESKTOP_LYRICS_UPDATE_EVENT, listener)
    return () => ipcRenderer.removeListener(DESKTOP_LYRICS_UPDATE_EVENT, listener)
  }
}

contextBridge.exposeInMainWorld('desktopLyrics', api)
