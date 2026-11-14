// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RealtimeSeparation from '../src/renderer/src/pages/RealtimeSeparation.js'
import { DEFAULT_REALTIME_CONFIG, type RealtimeState, type RealtimeSeparationApi } from '../packages/shared/src/realtime-separation.js'
import type { BandBuddyApi } from '../packages/shared/src/bridge.js'

let state: RealtimeState, api: RealtimeSeparationApi, notify: (state: RealtimeState) => void
const onToast = vi.fn()
beforeEach(() => {
  state = { phase: 'idle', config: { ...DEFAULT_REALTIME_CONFIG, source: 'virtual', output: 'speaker' }, eligible: false, message: '请先测试', progress: 0, metrics: null, lastTest: null }
  api = {
    state: vi.fn(async () => state), capabilities: vi.fn(async () => ({ supported: true, platform: 'win32', ready: true, device: 'cuda', devices: [
      { id: 'virtual', name: 'Virtual', input: true, output: true, kind: 'loopback' }, { id: 'speaker', name: 'Speaker', input: false, output: true, kind: 'device' }
    ] })),
    configure: vi.fn(async config => (state = { ...state, config, eligible: false })),
    mix: vi.fn(async input => (state = { ...state, config: { ...state.config, ...input } })),
    test: vi.fn(async () => (state = { ...state, phase: 'testing' })),
    start: vi.fn(async () => (state = { ...state, phase: 'running' })),
    stop: vi.fn(async () => (state = { ...state, phase: 'idle' })),
    openSetup: vi.fn(async () => {}), onChanged: callback => { notify = callback; return () => {} }
  }
  window.bandbuddy = { realtimeSeparation: api } as BandBuddyApi
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('realtime page', () => {
  it('gates playback until a passed event and supports cancellation', async () => {
    render(<RealtimeSeparation recording={false} onToast={onToast} />)
    const start = await screen.findByRole('button', { name: '开始实时分轨' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await waitFor(() => expect((screen.getByRole('button', { name: '运行性能测试' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '运行性能测试' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    await waitFor(() => expect(api.stop).toHaveBeenCalled())
    await act(async () => { state = { ...state, eligible: true, phase: 'idle' }; notify(state) })
    expect((screen.getByRole('button', { name: '开始实时分轨' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '开始实时分轨' }))
    await screen.findByRole('button', { name: '停止' })
    expect(api.start).toHaveBeenCalledOnce()
  })
  it('mixes multiple selected stems and disables an empty selection', async () => {
    render(<RealtimeSeparation recording={false} onToast={onToast} />)
    await screen.findByDisplayValue('Virtual')
    fireEvent.click(screen.getByRole('checkbox', { name: '人声' }))
    await waitFor(() => expect(api.mix).toHaveBeenCalledWith({ stems: ['drums', 'vocals'], mode: 'remove' }))
    fireEvent.click(screen.getByRole('button', { name: '只听所选' }))
    await waitFor(() => expect(api.mix).toHaveBeenLastCalledWith({ stems: ['drums', 'vocals'], mode: 'solo' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '鼓' }))
    await waitFor(() => expect(api.mix).toHaveBeenLastCalledWith({ stems: ['vocals'], mode: 'solo' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '人声' }))
    expect(screen.getByText('请至少选择一个声部。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '运行性能测试' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('blocks recording conflicts and releases the session when unmounted', async () => {
    const view = render(<RealtimeSeparation recording onToast={onToast} />)
    await screen.findByDisplayValue('Virtual')
    expect((screen.getByRole('button', { name: '运行性能测试' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    expect(api.stop).toHaveBeenCalledOnce()
  })
})
