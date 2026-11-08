// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimePreparation } from '../src/renderer/src/components/RuntimePreparation.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

beforeEach(() => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('prepares an absent runtime in the legacy preparation component, exposes download progress and cancellation, and removes the prompt when ready', async () => {
  const runtime = await window.bandbuddy.runtime.get()
  const install = vi.spyOn(window.bandbuddy.runtime, 'install').mockRejectedValueOnce(new Error('下载暂时失败')).mockResolvedValue(runtime)
  const cancel = vi.spyOn(window.bandbuddy.runtime, 'cancel')
  const { rerender } = render(<RuntimePreparation runtime={{ ...runtime, status: 'missing', progress: null, error: null }} />)
  fireEvent.click(screen.getByRole('button', { name: '一键准备分轨环境' }))
  await screen.findByRole('alert')
  expect(install).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '一键准备分轨环境' }))
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  rerender(<RuntimePreparation runtime={{ ...runtime, status: 'downloadingModel', stage: '正在下载模型', progress: .42, error: null }} />)
  expect(screen.getByRole('progressbar', { name: '环境准备进度' }).getAttribute('aria-valuenow')).toBe('42')
  fireEvent.click(screen.getByRole('button', { name: '取消准备' }))
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  rerender(<RuntimePreparation runtime={{ ...runtime, status: 'ready' }} />)
  expect(screen.queryByRole('region', { name: '准备分轨环境' })).toBeNull()
})
