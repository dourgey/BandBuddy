// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPreview } from '../src/renderer/src/components/ui/AudioPreview.js'
import { ArsenalPage } from '../src/renderer/src/pages/ArsenalPage.js'
import { Tuner } from '../src/renderer/src/woodshed/Tuner.js'
import { publishRecordingState, isRecordingLocked } from '../src/renderer/src/recording-session.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

beforeEach(() => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  publishRecordingState('practice', { phase: 'idle' }); publishRecordingState('rehearsal', { phase: 'idle' })
})
afterEach(() => { cleanup(); publishRecordingState('practice', { phase: 'idle' }); publishRecordingState('rehearsal', { phase: 'idle' }); vi.restoreAllMocks() })

describe('audio device and preview recording protection', () => {
  it.each(['practice', 'rehearsal'] as const)('blocks previews and microphone opening during %s recording', async owner => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const getUserMedia = vi.fn(async () => { throw new Error('should not open') })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} } })
    const rendered = render(<AudioPreview src="test.wav" />)
    fireEvent.click(screen.getByRole('button', { name: '播放录音' }))
    expect(play).toHaveBeenCalledOnce()
    act(() => publishRecordingState(owner, { phase: 'recording' }))
    expect(pause).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '播放录音' }))
    expect(play).toHaveBeenCalledOnce()
    rendered.unmount()
    render(<Tuner tuning={{ id: 'guitar', notes: [40, 45, 50, 55, 59, 64] }} capo={0} a4={440} onA4={() => {}} inputDevice="" onDevice={() => {}} audio={null} onError={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '开启调音' }))
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('keeps arsenal audio routing and monitor updates frozen while browsing during recording', async () => {
    publishRecordingState('rehearsal', { phase: 'paused' })
    const api = window.bandbuddy
    vi.spyOn(api.arsenal, 'monitorState').mockResolvedValue({ active: true, mode: 'wet', sampleRate: 48000, bufferFrames: 128, latencyMs: 3, peak: [], outputPeak: 0, xruns: 0, error: null })
    const devices = vi.spyOn(api.recording, 'devices')
    const monitor = vi.spyOn(api.arsenal, 'monitor')
    const reconcile = vi.spyOn(api.settings, 'reconcileAudio')
    const rendered = render(<ArsenalPage onToast={() => {}} />)
    await screen.findByRole('combobox', { name: '实时缓冲区' })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 90)) })
    expect((screen.getByRole('combobox', { name: '实时缓冲区' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '效果', exact: true }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '新建预设' }))
    expect(monitor).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(devices).not.toHaveBeenCalled()
    rendered.unmount()
    expect(monitor).not.toHaveBeenCalled()
  })

  it('unlocks on failed state and does not mistake input testing for song capture', () => {
    publishRecordingState('practice', { phase: 'recording', songId: 'song' })
    expect(isRecordingLocked()).toBe(true)
    publishRecordingState('practice', { phase: 'failed' })
    expect(isRecordingLocked()).toBe(false)
    publishRecordingState('practice', { phase: 'preparing', songId: null })
    expect(isRecordingLocked()).toBe(false)
    publishRecordingState('practice', { phase: 'testing' })
    expect(isRecordingLocked()).toBe(false)
  })
})
