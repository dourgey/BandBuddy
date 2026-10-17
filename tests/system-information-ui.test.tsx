// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SystemInformationReport } from '../packages/shared/src/environment.js'
import { SystemInformationButton } from '../src/renderer/src/components/SystemInformation.js'

const report: SystemInformationReport = { id: 'report-one', collectedAt: '2026-10-13T04:00:00Z', sections: [{ title: '处理器与内存', rows: [{ label: '处理器', value: 'Test CPU' }] }], text: '已脱敏的反馈文本' }
function setup(load = vi.fn(async () => report)) {
  const api = { systemInformation: load, copySystemInformation: vi.fn(async (_id: string) => {}) }
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { environment: api } })
  render(<SystemInformationButton />)
  return api
}
afterEach(cleanup)

it('collects only when opened, copies the displayed snapshot and refreshes explicitly', async () => {
  const api = setup()
  expect(api.systemInformation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '系统与环境信息' }))
  await screen.findByText('Test CPU')
  fireEvent.click(screen.getByRole('button', { name: '一键复制' }))
  await screen.findByText('已复制，可直接粘贴反馈。')
  expect(api.copySystemInformation).toHaveBeenCalledWith('report-one')
  api.systemInformation.mockResolvedValue({ ...report, id: 'report-two' })
  fireEvent.click(screen.getByRole('button', { name: '刷新信息' }))
  await screen.findByText('Test CPU')
  fireEvent.click(screen.getByRole('button', { name: '一键复制' }))
  await waitFor(() => expect(api.copySystemInformation).toHaveBeenLastCalledWith('report-two'))
})

it('keeps manual copy available when clipboard fails, and clears stale data on a failed refresh', async () => {
  const api = setup()
  fireEvent.click(screen.getByRole('button', { name: '系统与环境信息' }))
  await screen.findByText('Test CPU')
  api.copySystemInformation.mockRejectedValue(new Error('clipboard unavailable'))
  fireEvent.click(screen.getByRole('button', { name: '一键复制' }))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('完整反馈文本') as HTMLTextAreaElement).value).toBe(report.text)
  api.systemInformation.mockRejectedValue(new Error('读取失败，请重试'))
  fireEvent.click(screen.getByRole('button', { name: '刷新信息' }))
  await screen.findByText('读取失败，请重试')
  expect(screen.queryByText('Test CPU')).toBeNull()
  expect((screen.getByRole('button', { name: '一键复制' }) as HTMLButtonElement).disabled).toBe(true)
})

it('ignores an old response after closing and reopening the dialog', async () => {
  let resolve!: (value: SystemInformationReport) => void
  const load = vi.fn(() => new Promise<SystemInformationReport>(done => { resolve = done }))
  const api = setup(load)
  fireEvent.click(screen.getByRole('button', { name: '系统与环境信息' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭系统与环境信息' }))
  api.systemInformation.mockResolvedValue({ ...report, sections: [{ title: '处理器与内存', rows: [{ label: '处理器', value: 'New CPU' }] }] })
  fireEvent.click(screen.getByRole('button', { name: '系统与环境信息' }))
  await screen.findByText('New CPU')
  resolve(report)
  await waitFor(() => expect(screen.queryByText('Test CPU')).toBeNull())
})
