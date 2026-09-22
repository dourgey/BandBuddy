import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { AppSettings } from '../packages/shared/src/domain.js'
import { createDefaultRecordingAudioSettings } from '../packages/shared/src/domain.js'
import { DEFAULT_APPEARANCE } from '../packages/shared/src/appearance.js'
import { IPC } from '../packages/shared/src/channels.js'
import { registerIpc } from '../src/main/ipc.js'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>(), migration: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, callback: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => mocks.handlers.set(channel, callback), on: vi.fn() }, dialog: {}, shell: {} }))
vi.mock('../src/main/data-migration.js', () => ({ migrateDataRoots: mocks.migration }))
beforeEach(() => { mocks.handlers.clear(); vi.clearAllMocks() })

function install() {
  let settings: AppSettings = {
    appearance: { ...DEFAULT_APPEARANCE }, libraryRoot: '/离线磁盘/音乐', runtimeRoot: '/离线磁盘/环境', modelRoot: '/离线磁盘/环境/模型',
    desktopLyricsFontSize: 24, debugMode: false, preferredDevice: 'auto', audioOutputDeviceId: '离线声卡', latencyMode: 'balanced',
    recordingAudio: createDefaultRecordingAudioSettings(), keepSource: true, closeToTrayWhileWorking: true, highQualityStems: false, guitarSeparationQuality: 'balanced',
    network: { proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:9876', pythonInstallMirror: '', pythonIndexUrl: '', pytorchIndexUrl: '' }
  }
  const original = settings
  const forbidden = vi.fn((key: PropertyKey) => { throw new Error(`Unexpected appearance dependency: ${String(key)}`) })
  const webContents = { mainFrame: { url: 'app://bandbuddy/index.html' } }
  const saveSettings = vi.fn((value: AppSettings) => { settings = value; return value })
  const emitAppearance = vi.fn(), emitSettings = vi.fn()
  const allowed = {
    windowControlsRegistered: true,
    database: { getSettings: () => settings, saveSettings }, getWindow: () => ({ webContents }),
    logger: { capture: vi.fn() }, isTrustedUrl: (url: string) => url === webContents.mainFrame.url, emitAppearance, emitSettings
  }
  const services = new Proxy(allowed, { get: (target, key) => key in target ? target[key as keyof typeof target] : forbidden(key) })
  registerIpc(services as unknown as Parameters<typeof registerIpc>[0])
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  return { original, forbidden, saveSettings, emitAppearance, emitSettings, invoke: (channel: string, value?: unknown, sender = event) => mocks.handlers.get(channel)!(sender, value) }
}

describe('narrow appearance IPC', () => {
  it('gets and persists only appearance, without migration, device enumeration, or runtime probing', async () => {
    const services = install()
    expect(await services.invoke(IPC.appearanceGet)).toEqual(DEFAULT_APPEARANCE)
    const next = { ...DEFAULT_APPEARANCE, theme: 'dark', density: 'compact' }
    expect(await services.invoke(IPC.appearanceSet, next)).toEqual(next)
    expect(services.saveSettings).toHaveBeenCalledExactlyOnceWith({ ...services.original, appearance: next })
    expect(services.emitAppearance).toHaveBeenCalledExactlyOnceWith(next)
    expect(services.emitSettings).toHaveBeenCalledOnce()
    expect(services.forbidden).not.toHaveBeenCalled()
    expect(mocks.migration).not.toHaveBeenCalled()
  })

  it('rejects invalid fields before saving and never exposes unrelated settings on get', async () => {
    const services = install()
    await expect(services.invoke(IPC.appearanceSet, { theme: 'not-a-theme' })).rejects.toThrow()
    expect(services.saveSettings).not.toHaveBeenCalled()
    expect(services.emitAppearance).not.toHaveBeenCalled()
    expect(await services.invoke(IPC.appearanceGet)).not.toHaveProperty('network')
    expect(await services.invoke(IPC.appearanceGet)).not.toHaveProperty('libraryRoot')
  })

  it('retains the existing trusted-frame boundary for theme changes', async () => {
    const services = install()
    await expect(services.invoke(IPC.appearanceSet, DEFAULT_APPEARANCE, { sender: {}, senderFrame: { url: 'https://other.example/' } } as IpcMainInvokeEvent)).rejects.toThrow('UNTRUSTED_IPC_SENDER')
    expect(services.saveSettings).not.toHaveBeenCalled()
  })
})
