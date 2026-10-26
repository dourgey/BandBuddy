// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginControls, PluginPicker, useLocalPlugins } from '../src/renderer/src/arsenal/LocalPlugins.js'
import type { AudioPluginsApi, PluginCatalog, PluginDefinition } from '@shared/audio-plugins.js'

const empty: PluginCatalog = { version: 1, plugins: [], directories: [], failures: [] }
const found: PluginCatalog = { ...empty, plugins: [{ format: 'vst3', pluginId: 'effect', name: '自动效果', manufacturer: '厂商', version: '1',
  path: 'effect.vst3', fingerprint: 'a'.repeat(64), architecture: 'x64', instrument: false, validation: 'available', inputChannels: 1, outputChannels: 2, hasEditor: true }] }
function bridge() {
  const api = { list: vi.fn().mockResolvedValue(empty), scan: vi.fn().mockResolvedValue(found), addDirectory: vi.fn() } as unknown as AudioPluginsApi
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { audioPlugins: api } })
  Element.prototype.scrollIntoView = vi.fn()
  return api
}
function Harness({active=false, locked=false, onAdd=vi.fn()}: {active?: boolean; locked?: boolean; onAdd?(p: PluginDefinition): void}) {
  const {catalog, scanning, error} = useLocalPlugins(active, locked, 0)
  return <><PluginPicker catalog={catalog} scanning={scanning} locked={locked} onAdd={onAdd}/>{error && <p role="alert">{error}</p>}</>
}
const picker = () => screen.getByRole('combobox', {name: '添加 VST 插件'}) as HTMLButtonElement
async function ready() { await waitFor(() => expect(picker().disabled).toBe(false)) }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it('automatically discovers effects and chooses one from the ordinary add control', async () => {
  const api = bridge(), onAdd = vi.fn()
  render(<Harness onAdd={onAdd}/>); await ready()
  expect(api.scan).toHaveBeenCalledWith()
  expect(screen.queryByRole('button', { name: '扫描插件' })).toBeNull()
  expect(screen.queryByRole('button', { name: '添加目录' })).toBeNull()
  fireEvent.click(picker()); fireEvent.click(screen.getByRole('option', {name:'自动效果',exact:true}))
  expect(onAdd.mock.calls[0]![0]).toMatchObject({pluginId:'effect', fingerprint:'a'.repeat(64)})
})

it('waits through monitoring and recording, then automatically resumes', async () => {
  const api = bridge(), view = render(<Harness active />)
  expect(api.scan).not.toHaveBeenCalled()
  view.rerender(<Harness locked />); expect(api.scan).not.toHaveBeenCalled()
  view.rerender(<Harness />); await ready()
  expect(api.scan).toHaveBeenCalledTimes(1)
})

it('discovers later installs on a timer or window focus and stops after unmount', async () => {
  vi.useFakeTimers(); const api = bridge()
  vi.mocked(api.scan).mockResolvedValueOnce(empty)
  const view = render(<Harness />); await act(async () => {})
  expect(picker().disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(picker().disabled).toBe(false)
  await act(async () => { fireEvent.focus(window) }); expect(api.scan).toHaveBeenCalledTimes(3)
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); fireEvent.focus(window) })
  expect(api.scan).toHaveBeenCalledTimes(3)
})

it('keeps cached effects usable when a later automatic refresh fails', async () => {
  const api = bridge(); vi.mocked(api.list).mockResolvedValue(found)
  vi.mocked(api.scan).mockRejectedValue(new Error('组件不可用'))
  render(<Harness />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('组件不可用'))
  expect(picker().disabled).toBe(false)
})

const instance = { instanceId: 'one', format: 'vst3' as const, pluginId: 'effect', name: '自动效果', fingerprint: 'a'.repeat(64), stateHash: null, bypass: false, beforeModuleId: null }
it('opens from a rack request only after activation completes, and reopens the selected instance', async () => {
  const api = bridge()
  api.editor = vi.fn().mockResolvedValue(undefined)
  let activated!: () => void
  const activate = vi.fn(() => new Promise<void>(resolve => { activated = resolve }))
  const props = { plugin: instance, definition: found.plugins[0], active: true, locked: false, onActivate: activate }
  const view = render(<PluginControls {...props} openRequest={1} />)
  expect(activate).toHaveBeenCalledOnce()
  expect(api.editor).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '正在打开…' }))
  await act(async () => { activated() })
  expect(api.editor).toHaveBeenCalledExactlyOnceWith('one')
  view.rerender(<PluginControls {...props} openRequest={1} />)
  expect(api.editor).toHaveBeenCalledOnce()
  view.rerender(<PluginControls {...props} openRequest={2} />)
  await act(async () => { activated() })
  expect(api.editor).toHaveBeenCalledTimes(2)
})

it('shows activation errors and leaves the open button available for retry', async () => {
  const api = bridge(); api.editor = vi.fn()
  const activate = vi.fn().mockRejectedValueOnce(new Error('无法开启声卡')).mockResolvedValue(undefined)
  render(<PluginControls plugin={instance} definition={found.plugins[0]} active={false} locked={false} onActivate={activate} openRequest={1} />)
  expect((await screen.findByRole('alert')).textContent).toBe('无法开启声卡')
  expect(api.editor).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '打开插件' }))
  await waitFor(() => expect(api.editor).toHaveBeenCalledExactlyOnceWith('one'))
})

it('uses parameter controls for effects without a native editor and respects the recording lock', async () => {
  const api = bridge(); api.editor = vi.fn(); api.parameters = vi.fn().mockResolvedValue([{ id: 1, name: 'Gain', unit: '', value: .5, steps: 0, readOnly: false }])
  const activate = vi.fn().mockResolvedValue(undefined)
  const props = { plugin: instance, definition: { ...found.plugins[0]!, hasEditor: false }, active: true, onActivate: activate, openRequest: 1 }
  const view = render(<PluginControls {...props} locked />)
  expect(activate).not.toHaveBeenCalled()
  view.rerender(<PluginControls {...props} locked={false} />)
  expect(await screen.findByRole('slider', { name: '自动效果 Gain' })).toBeTruthy()
  expect(api.editor).not.toHaveBeenCalled()
})
