// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { usePlayerStore, useRecordingMeterStore } from '../src/renderer/src/player-store.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import type { AppSettings, JobRecord, RuntimeInfo } from '../packages/shared/src/domain.js'
const counters = vi.hoisted(() => ({ library: vi.fn(), engines: vi.fn() }))
vi.mock('../src/renderer/src/pages/LibraryPage.js', () => ({ LibraryPage: ({ loading }: { loading: boolean }) => { counters.library(); return <p>{loading ? 'loading-library' : 'ready-library'}</p> } }))
vi.mock('../src/renderer/src/audio-engine.js', () => ({ MultiTrackAudioEngine: class {
  constructor() { counters.engines() }
  onTime() {} onEnded() {} onError() {} destroy() {} applyPractice() {}
} }))
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  usePlayerStore.getState().loadSong(fixtureDetail(fixtureSongs[0]!))
})
afterEach(() => { cleanup(); usePlayerStore.getState().unload() })
describe('renderer update isolation', () => {
  const task: JobRecord = { id: 'task', songId: null, type: 'runtimeInstall', status: 'preparing', phase: '准备', progress: 0,
    errorCode: null, errorMessage: null, createdAt: '2026-09-22T00:00:00Z', startedAt: null, finishedAt: null }
  it('updates only the matching task for progress and completion without reloading the task list', async () => {
    const other = { ...task, id: 'other' }
    const list = vi.spyOn(window.bandbuddy.tasks, 'list').mockResolvedValue([task, other])
    let changed!: (job?: JobRecord) => void
    vi.spyOn(window.bandbuddy.tasks, 'onChanged').mockImplementation(callback => { changed = callback; return () => {} })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
    await waitFor(() => expect(client.getQueryData(['tasks'])).toEqual([task, other]))
    const completed = { ...task, status: 'completed' as const, phase: '完成', progress: 1 }
    act(() => { changed({ ...task, progress: .5 }); changed(completed) })
    expect(client.getQueryData(['tasks'])).toEqual([completed, other])
    expect(list).toHaveBeenCalledOnce()
    act(() => changed())
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })
  it('restarts an initial task read after an event so an older response cannot hide completion or other tasks', async () => {
    let resolveOld!: (value: JobRecord[]) => void
    const oldRead = new Promise<JobRecord[]>(resolve => { resolveOld = resolve })
    const completed = { ...task, status: 'completed' as const, phase: '完成', progress: 1 }
    const other = { ...task, id: 'other' }
    const list = vi.spyOn(window.bandbuddy.tasks, 'list').mockReturnValueOnce(oldRead).mockResolvedValue([completed, other])
    let changed!: (job?: JobRecord) => void
    vi.spyOn(window.bandbuddy.tasks, 'onChanged').mockImplementation(callback => { changed = callback; return () => {} })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
    await waitFor(() => expect(list).toHaveBeenCalledOnce())
    act(() => changed(completed))
    await waitFor(() => expect(client.getQueryData(['tasks'])).toEqual([completed, other]))
    await act(async () => { resolveOld([task]); await oldRead })
    expect(client.getQueryData(['tasks'])).toEqual([completed, other])
  })
  it('keeps settings and runtime broadcasts newer than delayed startup responses', async () => {
    const api = window.bandbuddy
    const oldSettings = await api.settings.get()
    const oldRuntime = await api.runtime.get()
    const newSettings = { ...oldSettings, audioOutputDeviceId: '最新用户设备' }
    const newRuntime = { ...oldRuntime, status: 'downloadingModel' as const, progress: .4 }
    let resolveSettings!: (value: AppSettings) => void, resolveRuntime!: (value: RuntimeInfo) => void
    let settingsChanged!: (value: AppSettings) => void, runtimeChanged!: (value: RuntimeInfo) => void
    vi.spyOn(api.settings, 'get').mockReturnValue(new Promise(resolve => { resolveSettings = resolve }))
    vi.spyOn(api.runtime, 'get').mockReturnValue(new Promise(resolve => { resolveRuntime = resolve }))
    vi.spyOn(api.settings, 'onChanged').mockImplementation(callback => { settingsChanged = callback; return () => {} })
    vi.spyOn(api.runtime, 'onChanged').mockImplementation(callback => { runtimeChanged = callback; return () => {} })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
    await screen.findByText('ready-library')
    act(() => { settingsChanged(newSettings); runtimeChanged(newRuntime) })
    await act(async () => { resolveSettings(oldSettings); resolveRuntime(oldRuntime); await Promise.resolve() })
    expect(client.getQueryData(['settings'])).toEqual(newSettings)
    expect(client.getQueryData(['runtime'])).toEqual(newRuntime)
  })
  it('keeps clock and meter ticks out of the library and does not construct engines on rerender', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
    await screen.findByText('ready-library')
    await act(async () => { await Promise.resolve() })
    const rendered = counters.library.mock.calls.length
    const engines = counters.engines.mock.calls.length
    act(() => {
      for (let tick = 1; tick <= 120; tick++) {
        usePlayerStore.getState().setCurrentMs(tick * 16.67)
        useRecordingMeterStore.getState().setMeter({ peak: [.3, .3], rms: [.1, .1], clipped: false, sourcePositionMs: tick * 16.67, recording: true })
      }
    })
    expect(counters.library).toHaveBeenCalledTimes(rendered)
    expect(counters.engines).toHaveBeenCalledTimes(engines)
    expect(usePlayerStore.getState().currentMs).toBe(120 * 16.67)
  })
})
