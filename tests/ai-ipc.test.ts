import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { AI_CHANNEL, DEFAULT_AI_SETTINGS } from '../packages/shared/src/ai.js'
import { registerIpc } from '../src/main/ipc.js'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() }, clipboard: {}, dialog: {}, shell: {} }))
vi.mock('../src/main/data-migration.js', () => ({ migrateDataRoots: vi.fn() }))
beforeEach(() => { handlers.clear(); vi.clearAllMocks() })
function setup() {
  const webContents = { mainFrame: { url: 'app://bandbuddy/index.html' } }
  const ai = { getSettings: vi.fn(() => ({ settings: DEFAULT_AI_SETTINGS, hasToken: false })), saveSettings: vi.fn(), send: vi.fn(), delete: vi.fn() }
  const capture = vi.fn()
  registerIpc({ ai, windowControlsRegistered: true, getWindow: () => ({ webContents }), isTrustedUrl: (url: string) => url === webContents.mainFrame.url, logger: { capture } } as unknown as Parameters<typeof registerIpc>[0])
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  return { ai, capture, event, invoke: (input: unknown, sender = event) => handlers.get(AI_CHANNEL)!(sender, input) }
}
describe('AI IPC boundary', () => {
  it('allows only the main trusted frame, rejecting foreign windows and subframes', async () => {
    const { invoke, event, ai } = setup()
    await expect(invoke({ op: 'settings' }, { ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('UNTRUSTED_IPC_SENDER')
    await expect(invoke({ op: 'settings' }, { ...event, senderFrame: { url: 'app://bandbuddy/index.html' } } as IpcMainInvokeEvent)).rejects.toThrow('UNTRUSTED_IPC_SENDER')
    expect(ai.getSettings).not.toHaveBeenCalled()
    expect(await invoke({ op: 'settings' })).toMatchObject({ hasToken: false })
  })
  it('validates commands and identifiers before invoking the service', async () => {
    const { invoke, ai } = setup()
    await expect(invoke({ op: 'execute', input: {} })).rejects.toThrow()
    await expect(invoke({ op: 'delete', id: '../other-file' })).rejects.toThrow()
    expect(ai.delete).not.toHaveBeenCalled()
  })
  it('keeps tokens and chat failures out of generic diagnostics', async () => {
    const { invoke, ai, capture } = setup()
    const input = { settings: DEFAULT_AI_SETTINGS, token: 'local-test-secret' }
    await invoke({ op: 'saveSettings', input })
    expect(ai.saveSettings).toHaveBeenCalledExactlyOnceWith(input)
    ai.send.mockImplementation(() => { throw new Error('回复失败') })
    await expect(invoke({ op: 'send', input: { text: 'private conversation' } })).rejects.toThrow('回复失败')
    expect(capture).not.toHaveBeenCalled()
  })
})
