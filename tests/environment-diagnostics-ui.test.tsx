// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EnvironmentStatus } from '../src/renderer/src/components/EnvironmentStatus.js'
import type { EnvironmentApi, EnvironmentIssue, EnvironmentState } from '../packages/shared/src/environment.js'

afterEach(cleanup)
it('shows the failing stage, evidence, attempted repair and scoped actions', async () => {
  const issue: EnvironmentIssue = { diagnosticId: '10000000-0000-4000-8000-000000000001', capability: 'separation', component: 'network', stage: '下载模型', code: 'DOWNLOAD_SOURCE_MISSING', message: '来源缺少此版本', confidence: 'confirmed', action: 'network', evidence: { name: 'Error', code: 'DOWNLOAD_HTTP_404', message: 'HTTP 404' }, attempts: [{ at: '', action: '切换可信来源', result: '失败' }], nextSteps: ['检查下载来源或更新应用'] }
  const state: EnvironmentState = { phase: 'needsAction', message: issue.message, issues: [issue], capabilities: { startup: 'ready', media: 'ready', recording: 'ready', separation: 'unavailable', acceleration: 'unavailable' }, progress: null, totalBytes: null, receivedBytes: 0, pausedByUser: false, safeMode: false }
  const api = { get: vi.fn(async () => state), onChanged: () => () => {}, check: vi.fn(async () => state), diagnostics: vi.fn(async () => ({ issues: [issue], events: [], persistenceError: null })), copyDiagnostics: vi.fn(async () => {}), exportDiagnostics: vi.fn(async () => null) } as unknown as EnvironmentApi
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { environment: api } })
  render(<EnvironmentStatus />)
  await screen.findByText('本地分轨 · 下载模型')
  expect(screen.getByText('已尝试：切换可信来源（失败）')).toBeTruthy()
  expect(screen.getByText('检查下载来源或更新应用')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重新检测此项' }))
  await waitFor(() => expect(api.check).toHaveBeenCalledWith(issue.diagnosticId))
  fireEvent.click(screen.getByRole('button', { name: '查看故障详情' }))
  await waitFor(() => expect(api.diagnostics).toHaveBeenCalledWith({ diagnosticId: issue.diagnosticId }))
  fireEvent.click(screen.getAllByRole('button', { name: '复制问题摘要' })[1]!)
  await waitFor(() => expect(api.copyDiagnostics).toHaveBeenCalledWith({ diagnosticId: issue.diagnosticId }))
})
