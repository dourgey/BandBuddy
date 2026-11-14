// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnvironmentApi, EnvironmentState } from '../packages/shared/src/environment.js'
import { SettingsDrawer } from '../src/renderer/src/components/Dialogs.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

beforeEach(() => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('retries environment preparation from settings and reflects progress, pause and readiness', async () => {
  const runtime = await window.bandbuddy.runtime.get()
  const settings = await window.bandbuddy.settings.get()
  const missing: EnvironmentState = {
    phase: 'needsAction', message: '本地分轨环境尚未准备', issues: [], progress: null,
    totalBytes: null, receivedBytes: 0, pausedByUser: false, safeMode: false,
    capabilities: { startup: 'ready', media: 'ready', recording: 'ready', separation: 'unavailable', acceleration: 'unchecked' }
  }
  const preparing: EnvironmentState = { ...missing, phase: 'preparing', message: '正在下载模型', progress: .42, totalBytes: 100, receivedBytes: 42 }
  const paused: EnvironmentState = { ...preparing, phase: 'paused', message: '环境准备已暂停', pausedByUser: true }
  const ready: EnvironmentState = { ...missing, phase: 'ready', message: '环境准备完成', capabilities: { ...missing.capabilities, separation: 'ready' } }
  let onChanged!: (state: EnvironmentState) => void
  const resume = vi.fn(async () => { onChanged(preparing); return preparing }).mockRejectedValueOnce(new Error('下载暂时失败'))
  const pause = vi.fn(async () => { onChanged(paused); return paused })
  const api: EnvironmentApi = {
    get: async () => missing, onChanged: callback => { onChanged = callback; return () => {} },
    resume, pause, prepare: async () => preparing, check: async () => missing, repair: async () => missing,
    networkRestored: async () => {}, exportDiagnostics: async () => null, openAction: async () => {}
  }
  window.bandbuddy.environment = api

  render(<SettingsDrawer open onOpenChange={vi.fn()} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '分轨与运行环境' }))
  const status = within(await screen.findByRole('region', { name: '运行状态' }))
  fireEvent.click(status.getByRole('button', { name: '继续准备' }))
  expect((await status.findByRole('alert')).textContent).toContain('操作未完成')
  fireEvent.click(status.getByRole('button', { name: '继续准备' }))
  const progress = await status.findByRole('progressbar', { name: '组件准备进度' }) as HTMLProgressElement
  expect(progress.value).toBe(.42)
  expect(resume).toHaveBeenCalledTimes(2)
  expect(status.queryByRole('alert')).toBeNull()
  fireEvent.click(status.getByRole('button', { name: '暂停' }))
  await waitFor(() => expect(pause).toHaveBeenCalledOnce())
  expect(status.getByRole('status').textContent).toBe(paused.message)
  fireEvent.click(status.getByRole('button', { name: '继续准备' }))
  await status.findByRole('progressbar', { name: '组件准备进度' })
  expect(resume).toHaveBeenCalledTimes(3)
  act(() => onChanged(ready))
  expect(status.getByRole('status').textContent).toBe(ready.message)
  expect(status.queryByRole('progressbar')).toBeNull()
  expect(status.queryByRole('button', { name: '继续准备' })).toBeNull()
  expect(status.queryByRole('button', { name: '暂停' })).toBeNull()
})
