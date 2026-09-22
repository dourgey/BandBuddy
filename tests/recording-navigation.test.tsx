// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'
import { getRecordingSession, publishRecordingState } from '../src/renderer/src/recording-session.js'
import type { RecordingState } from '../packages/shared/src/domain.js'
const audio = vi.hoisted(() => ({ play: vi.fn(async () => true), pause: vi.fn(), load: vi.fn(async () => {}), destroy: vi.fn() }))
vi.mock('../src/renderer/src/audio-engine.js', () => ({ MultiTrackAudioEngine: class {
  onTime() {} onEnded() {} onError() {} applyPractice() {} setOutputDevice = async () => undefined
  play = audio.play; pause = audio.pause; load = audio.load; destroy = audio.destroy
} }))
vi.mock('../src/renderer/src/pages/PracticeRoom.js', () => ({ PracticeRoom: ({ onRecord }: { onRecord(id: string): void }) => <button onClick={() => onRecord('record-track')}>启动录音</button> }))
vi.mock('../src/renderer/src/pages/WoodshedPage.js', () => ({ default: () => <p>测试练功房</p> }))
vi.mock('../src/renderer/src/pages/ArsenalPage.js', () => ({ ArsenalPage: () => <p>测试军火库</p> }))
vi.mock('../src/renderer/src/pages/RehearsalRoom.js', () => ({ RehearsalRoom: () => <p>测试排练房</p> }))
let state: RecordingState
let emit!: (next: RecordingState) => void
const navigate = (name: string): void => fireEvent.click(screen.getByRole('button', { name, exact: true }))
function renderApp() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><App /></QueryClientProvider>) }
beforeEach(async () => {
  vi.clearAllMocks()
  publishRecordingState('practice', { phase: 'idle' }); publishRecordingState('rehearsal', { phase: 'idle' })
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  usePlayerStore.getState().loadSong(fixtureDetail(fixtureSongs[0]!))
  state = await window.bandbuddy.recording.state()
  vi.spyOn(window.bandbuddy.recording, 'state').mockImplementation(async () => state)
  vi.spyOn(window.bandbuddy.recording, 'onState').mockImplementation(listener => { emit = next => { state = next; listener(next) }; return () => {} })
})
afterEach(() => { cleanup(); publishRecordingState('practice', { phase: 'idle' }); publishRecordingState('rehearsal', { phase: 'idle' }); usePlayerStore.getState().unload(); vi.restoreAllMocks() })

describe('practice recording across navigation', () => {
  it.each(['preparing', 'armed', 'countIn', 'recording', 'stopping', 'finalizing'] as const)('preserves %s while navigating and searching, and prevents changing the song', async phase => {
    state = { ...state, phase, songId: fixtureSongs[0]!.id }
    const stop = vi.spyOn(window.bandbuddy.recording, 'stop')
    const cancel = vi.spyOn(window.bandbuddy.recording, 'cancel')
    renderApp()
    const globalControls = await screen.findByRole('complementary', { name: '全局录音控制' })
    if (phase === 'stopping' || phase === 'finalizing') {
      expect((within(globalControls).getByRole('button', { name: '停止并保存录音' }) as HTMLButtonElement).disabled).toBe(true)
      expect((within(globalControls).getByRole('button', { name: '放弃录音' }) as HTMLButtonElement).disabled).toBe(true)
    }
    for (const page of ['练功房', '军火库', '排练房', '曲库']) navigate(page)
    const search = await screen.findByRole('textbox', { name: '搜索歌曲或艺术家' })
    fireEvent.change(search, { target: { value: fixtureSongs[0]!.title } })
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(fixtureSongs[0]!.title))
    const songBefore = usePlayerStore.getState().song
    fireEvent.click(await screen.findByRole('button', { name: `播放 ${fixtureSongs[0]!.title}` }))
    // The main practice controls stay locked while navigation remains usable.
    navigate('练习室')
    fireEvent.click(await screen.findByRole('button', { name: '启动录音' }))
    expect(usePlayerStore.getState().song).toBe(songBefore)
    expect(getRecordingSession()?.phase).toBe(phase)
    expect(audio.load).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(audio.destroy).not.toHaveBeenCalled()
  })

  it('stops and saves from another page through the original recording controller', async () => {
    state = { ...state, phase: 'recording', songId: fixtureSongs[0]!.id }
    const stop = vi.spyOn(window.bandbuddy.recording, 'stop').mockImplementation(async () => { emit({ ...state, phase: 'idle' }); return { cancelled: false, take: null } })
    renderApp()
    await screen.findByRole('complementary', { name: '全局录音控制' })
    navigate('军火库')
    await screen.findByText('测试军火库')
    expect(stop).not.toHaveBeenCalled()
    navigate('停止并保存录音')
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '全局录音控制' })).toBeNull())
  })

  it('cancels preflight without starting capture after the pending save completes', async () => {
    let saved!: () => void
    const save = new Promise<void>(resolve => { saved = resolve })
    vi.spyOn(window.bandbuddy.library, 'savePractice').mockReturnValue(save)
    const start = vi.spyOn(window.bandbuddy.recording, 'start')
    const cancel = vi.spyOn(window.bandbuddy.recording, 'cancel')
    renderApp()
    navigate('练习室')
    fireEvent.click(await screen.findByRole('button', { name: '启动录音' }))
    expect(getRecordingSession()?.phase).toBe('starting')
    navigate('曲库')
    const controls = screen.getByRole('complementary', { name: '全局录音控制' })
    fireEvent.click(within(controls).getByRole('button', { name: '放弃录音' }))
    await waitFor(() => expect(getRecordingSession()).toBeNull())
    await act(async () => { saved(); await save })
    expect(start).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('does not let an older cancelled preparation clear a new preparation', async () => {
    renderApp()
    navigate('练习室')
    const startButton = await screen.findByRole('button', { name: '启动录音' })
    let finishFirst!: () => void, finishSecond!: () => void
    const first = new Promise<void>(resolve => { finishFirst = resolve })
    const second = new Promise<void>(resolve => { finishSecond = resolve })
    vi.spyOn(window.bandbuddy.library, 'savePractice').mockReturnValueOnce(first).mockReturnValueOnce(second)
    const start = vi.spyOn(window.bandbuddy.recording, 'start')
    fireEvent.click(startButton)
    navigate('放弃录音')
    await waitFor(() => expect(getRecordingSession()).toBeNull())
    fireEvent.click(startButton)
    expect(getRecordingSession()?.phase).toBe('starting')
    await act(async () => { finishFirst(); await first })
    expect(getRecordingSession()?.phase).toBe('starting')
    navigate('放弃录音')
    await act(async () => { finishSecond(); await second })
    expect(getRecordingSession()).toBeNull()
    expect(start).not.toHaveBeenCalled()
  })

  it('cancels again after a delayed native start acknowledges an already cancelled preparation', async () => {
    let complete!: (result: { sessionId: string }) => void
    const pending = new Promise<{ sessionId: string }>(resolve => { complete = resolve })
    const start = vi.spyOn(window.bandbuddy.recording, 'start').mockReturnValue(pending)
    const cancel = vi.spyOn(window.bandbuddy.recording, 'cancel').mockImplementation(async () => { emit({ ...state, phase: 'idle' }) })
    renderApp()
    navigate('练习室')
    fireEvent.click(await screen.findByRole('button', { name: '启动录音' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    navigate('放弃录音')
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(getRecordingSession()?.phase).toBe('starting')
    await act(async () => { complete({ sessionId: 'late-session' }); await pending })
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(getRecordingSession()).toBeNull())
  })

  it('releases the recording guard after a failure without stopping or cancelling a new session', async () => {
    state = { ...state, phase: 'recording', songId: fixtureSongs[0]!.id }
    renderApp()
    await screen.findByRole('complementary', { name: '全局录音控制' })
    act(() => emit({ ...state, phase: 'failed', error: '设备已断开' }))
    expect(getRecordingSession()).toBeNull()
    expect(screen.queryByRole('complementary', { name: '全局录音控制' })).toBeNull()
    expect(screen.getByText(/设备已断开/)).toBeTruthy()
  })
})
