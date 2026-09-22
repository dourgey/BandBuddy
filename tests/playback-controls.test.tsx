// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App.js'
import { VideoPlayer } from '../src/renderer/src/components/VideoPlayer.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'

const audio = vi.hoisted(() => ({
  play: vi.fn(async () => true), pause: vi.fn(), seek: vi.fn(), applyPractice: vi.fn(),
  load: vi.fn(async () => undefined), destroy: vi.fn(), onTime: vi.fn(), onEnded: vi.fn(), onError: vi.fn(),
  setOutputDevice: vi.fn(async () => undefined), outputLatencySeconds: 0, availableOutputChannelPairs: 1
}))
vi.mock('../src/renderer/src/audio-engine.js', () => ({ MultiTrackAudioEngine: class { constructor() { return audio } } }))
vi.mock('../src/renderer/src/components/Waveform.js', () => ({ Waveform: () => <div className="waveform" /> }))

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  usePlayerStore.getState().loadSong(fixtureDetail(fixtureSongs[0]!))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
})

afterEach(() => {
  cleanup()
  usePlayerStore.getState().unload()
  vi.restoreAllMocks()
})

async function openPractice(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: '打开练习室' }))
  await screen.findByRole('button', { name: '设置 A 点' })
}

describe('practice transport interaction', () => {
  it('keeps playback running when navigating between practice and library', async () => {
    await openPractice()
    act(() => { usePlayerStore.getState().setPlaying(true); usePlayerStore.getState().setCurrentMs(12345) })
    audio.pause.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '曲库', exact: true }))
    await screen.findByRole('textbox', { name: '搜索歌曲或艺术家' })
    expect(usePlayerStore.getState().playing).toBe(true)
    expect(usePlayerStore.getState().currentMs).toBe(12345)
    expect(audio.pause).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '练习室', exact: true }))
    await screen.findByRole('button', { name: '设置 A 点' })
    expect(usePlayerStore.getState().playing).toBe(true)
    expect(audio.pause).not.toHaveBeenCalled()
  })

  it('allows navigation while recording without stopping the recording', async () => {
    const state = await window.bandbuddy.recording.state()
    window.bandbuddy.recording.state = async () => ({ ...state, phase: 'recording', songId: fixtureSongs[0]!.id })
    const cancel = vi.spyOn(window.bandbuddy.recording, 'cancel')
    const stop = vi.spyOn(window.bandbuddy.recording, 'stop')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
    const navigation = screen.getByRole('button', { name: '练习室', exact: true }) as HTMLButtonElement
    await screen.findByRole('complementary', { name: '全局录音控制' })
    expect(navigation.disabled).toBe(false)
    fireEvent.click(navigation)
    expect(stop).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cycles one button through A, B with automatic playback, and cancellation', async () => {
    await openPractice()
    act(() => usePlayerStore.getState().setCurrentMs(8000))
    fireEvent.click(screen.getByRole('button', { name: '设置 A 点' }))
    expect(usePlayerStore.getState().practice).toMatchObject({ loopStartMs: 8000, loopEndMs: null, loopEnabled: false })
    fireEvent.click(screen.getByRole('button', { name: '设置 B 点并开始循环' }))
    expect(audio.play).not.toHaveBeenCalled()
    expect(usePlayerStore.getState().practice?.loopEndMs).toBeNull()
    act(() => usePlayerStore.getState().setCurrentMs(15_000))
    fireEvent.click(screen.getByRole('button', { name: '设置 B 点并开始循环' }))
    await waitFor(() => expect(usePlayerStore.getState().playing).toBe(true))
    expect(usePlayerStore.getState().practice).toMatchObject({ loopStartMs: 8000, loopEndMs: 15_000, loopEnabled: true })
    expect(audio.seek).toHaveBeenLastCalledWith(8000)
    expect(audio.play).toHaveBeenLastCalledWith(0, expect.any(Function))
    expect(screen.getByRole('button', { name: '取消 A-B 循环' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '取消 A-B 循环' }))
    expect(usePlayerStore.getState().practice).toMatchObject({ loopStartMs: null, loopEndMs: null, loopEnabled: false })
    expect(usePlayerStore.getState().playing).toBe(true)
    expect(audio.play).toHaveBeenCalledOnce()
  })

  it('restarts a paused song at A only while the loop is enabled', async () => {
    await openPractice()
    act(() => {
      usePlayerStore.getState().patchPractice({ loopStartMs: 6000, loopEndMs: 12_000, loopEnabled: true, countInBeats: 4 })
      usePlayerStore.getState().setCurrentMs(9000)
    })
    fireEvent.click(screen.getByRole('button', { name: '跳回 A 点并播放' }))
    await waitFor(() => expect(usePlayerStore.getState().playing).toBe(true))
    expect(audio.seek).toHaveBeenLastCalledWith(6000)
    expect(audio.play).toHaveBeenLastCalledWith(0, expect.any(Function))
    act(() => {
      usePlayerStore.getState().patchPractice({ loopEnabled: false })
      usePlayerStore.getState().setPlaying(false)
    })
    fireEvent.click(screen.getByRole('button', { name: '跳回开头并播放' }))
    await waitFor(() => expect(usePlayerStore.getState().playing).toBe(true))
    expect(audio.seek).toHaveBeenLastCalledWith(0)
  })

  it('uses L for the three stages and Home for restart, without clearing a loop on fullscreen Escape', async () => {
    await openPractice()
    act(() => usePlayerStore.getState().setCurrentMs(3000))
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    act(() => usePlayerStore.getState().setCurrentMs(6000))
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    await waitFor(() => expect(usePlayerStore.getState().playing).toBe(true))
    fireEvent.keyDown(window, { key: 'Home' })
    expect(audio.seek).toHaveBeenLastCalledWith(3000)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePlayerStore.getState().practice?.loopEnabled).toBe(true)
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    expect(usePlayerStore.getState().practice?.loopEnabled).toBe(false)
  })

  it('shows one video instead of six waveforms and keeps the mixer controls', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    usePlayerStore.getState().loadSong({ ...song, videoUrl: '/fixture-video.webm' })
    await openPractice()
    expect(document.querySelectorAll('video')).toHaveLength(1)
    expect(document.querySelectorAll('.waveform')).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: 'M', exact: true })).toHaveLength(6)
    expect(screen.getByRole('button', { name: '全屏播放视频' })).toBeTruthy()
    expect(document.querySelector('video')?.muted).toBe(true)
  })
})

describe('fullscreen video controls', () => {
  it('uses the same playback, loop, seek and speed callbacks in fullscreen', async () => {
    const props = {
      src: '/fixture-video.webm', title: '现场', currentMs: 5000, durationMs: 60_000, playing: false,
      practice: fixtureDetail(fixtureSongs[0]!).practice, locked: false, outputLatencyMs: 0,
      onToggle: vi.fn(), onSeek: vi.fn(), onRestart: vi.fn(), onCycleLoop: vi.fn(), onRateChange: vi.fn()
    }
    const fullscreen = vi.fn(function (this: HTMLElement) {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: this })
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    })
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: fullscreen })
    render(<VideoPlayer {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '全屏播放视频' }))
    await screen.findByRole('button', { name: '退出视频全屏' })
    expect(fullscreen).toHaveBeenCalledOnce()
    const controls = within(document.querySelector('.video-fullscreen-controls') as HTMLElement)
    fireEvent.click(controls.getByRole('button', { name: '播放视频练习' }))
    fireEvent.click(controls.getByRole('button', { name: '跳回开头并播放' }))
    fireEvent.click(controls.getByRole('button', { name: '设置 A 点' }))
    fireEvent.change(controls.getByRole('slider', { name: '视频播放进度' }), { target: { value: '8000' } })
    fireEvent.change(controls.getByRole('slider', { name: '视频播放速度' }), { target: { value: '0.8' } })
    expect(props.onToggle).toHaveBeenCalledOnce()
    expect(props.onRestart).toHaveBeenCalledOnce()
    expect(props.onCycleLoop).toHaveBeenCalledOnce()
    expect(props.onSeek).toHaveBeenCalledWith(8000)
    expect(props.onRateChange).toHaveBeenCalledWith(0.8)
  })
})

it('M shortcut restores a track silenced at the gain floor', async () => {
  await openPractice()
  act(() => {
    usePlayerStore.getState().setSelectedStem('vocals')
    usePlayerStore.getState().patchTrack('vocals', { gainDb: -60, muted: false })
  })
  fireEvent.keyDown(window, { key: 'm', code: 'KeyM' })
  expect(usePlayerStore.getState().practice!.tracks.find(t => t.stemType === 'vocals')).toMatchObject({ gainDb: 0, muted: false })
})
it('output menu consumes transport keys while choosing a channel', async () => {
  await openPractice()
  const menu = screen.getByRole('combobox', { name: '人声输出通道' })
  fireEvent.click(menu)
  audio.seek.mockClear()
  fireEvent.keyDown(menu, { key: 'ArrowRight', code: 'ArrowRight' })
  expect(audio.seek).not.toHaveBeenCalled()
})
