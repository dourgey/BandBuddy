// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'
import { claimAudioSession, getAudioSession, pauseAudioSession } from '../src/renderer/src/audio-session.js'
import { publishRecordingState, registerRecordingControls } from '../src/renderer/src/recording-session.js'
import { applyAppearance } from '../src/renderer/src/appearance.js'
const events = vi.hoisted(() => ({
  rehearsalMount: vi.fn(), rehearsalDestroy: vi.fn(), rehearsalPause: vi.fn(),
  woodshedMount: vi.fn(), woodshedDestroy: vi.fn(), woodshedPause: vi.fn(),
  practicePlay: vi.fn(async () => true), practicePause: vi.fn(), practiceDestroy: vi.fn()
}))
vi.mock('../src/renderer/src/audio-engine.js', () => ({ MultiTrackAudioEngine: class {
  onTime() {} onEnded() {} onError() {} applyPractice() {} setOutputDevice = async () => undefined
  destroy = events.practiceDestroy; play = events.practicePlay; pause = events.practicePause
} }))
vi.mock('../src/renderer/src/pages/LibraryPage.js', () => ({ LibraryPage: () => <p>测试曲库</p> }))
vi.mock('../src/renderer/src/pages/PracticeRoom.js', () => ({ PracticeRoom: () => <p>测试练习</p> }))
vi.mock('../src/renderer/src/pages/ArsenalPage.js', () => ({ ArsenalPage: () => <p>测试军火库</p> }))
vi.mock('../src/renderer/src/pages/WoodshedPage.js', () => ({ default: ({ active }: { active: boolean }) => {
  useEffect(() => { events.woodshedMount(); return events.woodshedDestroy }, [])
  return <button onClick={() => claimAudioSession('woodshed', '音阶', events.woodshedPause)}>开始练功{active ? '可见' : '隐藏'}</button>
} }))
vi.mock('../src/renderer/src/pages/RehearsalRoom.js', () => ({ RehearsalRoom: ({ active, onRecordingLockChange }: { active: boolean; onRecordingLockChange(value: boolean): void }) => {
  useEffect(() => { events.rehearsalMount(); const unregister = registerRecordingControls('rehearsal', { stop: () => window.bandbuddy.rehearsals.stopRecording(), cancel: () => window.bandbuddy.rehearsals.cancelRecording() }); return () => { unregister(); publishRecordingState('rehearsal', { phase: 'idle' }); events.rehearsalDestroy() } }, [])
  return <><button onClick={() => claimAudioSession('rehearsal', '周末排练', events.rehearsalPause)}>开始排练{active ? '可见' : '隐藏'}</button><button onClick={() => { publishRecordingState('rehearsal', { phase: 'recording' }); onRecordingLockChange(true) }}>开始排练录音</button></>
} }))
vi.mock('../src/renderer/src/components/PlayerBar.js', () => ({ PlayerBar: ({ onToggle }: { onToggle(): void }) => <button onClick={onToggle}>切换歌曲播放</button> }))

beforeEach(() => {
  pauseAudioSession()
  vi.clearAllMocks()
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  usePlayerStore.getState().loadSong(fixtureDetail(fixtureSongs[0]!))
})
afterEach(() => { cleanup(); pauseAudioSession(); usePlayerStore.getState().unload(); vi.restoreAllMocks() })
const navigate = (name: string): void => { fireEvent.click(screen.getByRole('button', { name, exact: true })) }
const renderApp = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><App /></QueryClientProvider>)

describe('cross-page audio session navigation', () => {
  it('visits rooms lazily, preserves their instances and playback across pages/theme, and exposes background controls', async () => {
    renderApp()
    await screen.findByText('测试曲库')
    expect(events.rehearsalMount).not.toHaveBeenCalled()
    expect(events.woodshedMount).not.toHaveBeenCalled()
    navigate('排练房')
    fireEvent.click(await screen.findByRole('button', { name: '开始排练可见' }))
    navigate('练功房')
    await screen.findByRole('button', { name: '开始练功可见' })
    expect(events.rehearsalPause).not.toHaveBeenCalled()
    expect(events.rehearsalDestroy).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary', { name: '后台播放控制' }).textContent).toContain('周末排练')
    act(() => { applyAppearance({ theme: 'dark' }) })
    expect(events.rehearsalPause).not.toHaveBeenCalled()
    expect(events.rehearsalMount).toHaveBeenCalledTimes(1)
    navigate('开始练功可见')
    expect(events.rehearsalPause).toHaveBeenCalledOnce()
    expect(getAudioSession()?.owner).toBe('woodshed')
    navigate('军火库')
    await screen.findByText('测试军火库')
    expect(events.woodshedDestroy).not.toHaveBeenCalled()
    expect(events.woodshedPause).not.toHaveBeenCalled()
    navigate('返回练功房')
    await screen.findByRole('button', { name: '开始练功可见' })
    expect(events.woodshedMount).toHaveBeenCalledTimes(1)
    navigate('曲库')
    navigate('暂停练功房播放')
    expect(events.woodshedPause).toHaveBeenCalledOnce()
    expect(screen.queryByRole('complementary', { name: '后台播放控制' })).toBeNull()
  })

  it('keeps the practice engine playing on navigation and only pauses when another room explicitly starts', async () => {
    renderApp()
    navigate('切换歌曲播放')
    await waitFor(() => expect(usePlayerStore.getState().playing).toBe(true))
    events.practicePause.mockClear()
    navigate('排练房')
    await screen.findByRole('button', { name: '开始排练可见' })
    expect(events.practicePause).not.toHaveBeenCalled()
    expect(events.practiceDestroy).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary', { name: '后台播放控制' }).textContent).toContain('练习室正在播放')
    navigate('开始排练可见')
    expect(events.practicePause).toHaveBeenCalledOnce()
    expect(usePlayerStore.getState().playing).toBe(false)
  })

  it('allows recording navigation and appearance changes without stopping recording', async () => {
    const stop = vi.spyOn(window.bandbuddy.rehearsals, 'stopRecording')
    const cancel = vi.spyOn(window.bandbuddy.rehearsals, 'cancelRecording')
    const updateSettings = vi.spyOn(window.bandbuddy.settings, 'update')
    const appearance = vi.spyOn(window.bandbuddy.appearance, 'set')
    renderApp()
    navigate('排练房')
    fireEvent.click(await screen.findByRole('button', { name: '开始排练录音' }))
    expect((screen.getByRole('button', { name: '曲库', exact: true }) as HTMLButtonElement).disabled).toBe(false)
    navigate('曲库')
    await screen.findByText('测试曲库')
    expect(screen.getByRole('complementary', { name: '全局录音控制' })).toBeTruthy()
    expect(events.rehearsalDestroy).not.toHaveBeenCalled()
    navigate('设置')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('外观')
    expect(dialog.textContent).not.toContain('音频输出')
    fireEvent.click(screen.getByRole('button', { name: '暖纸色' }))
    await waitFor(() => expect(appearance).toHaveBeenCalledWith(expect.objectContaining({ theme: 'warm' })))
    expect(stop).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
