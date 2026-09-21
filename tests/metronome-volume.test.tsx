// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App.js'
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

describe('metronome level', () => {
  it('exposes its own slider and editable readout inside the metronome panel', async () => {
    await openPractice()
    fireEvent.click(screen.getByRole('button', { name: '节拍器' }))

    const slider = screen.getByRole('slider', { name: '节拍器音量滑块' }) as HTMLInputElement
    expect([slider.min, slider.max, slider.step]).toEqual(['-6', '6', '0.5'])
    // Unity sits exactly in the middle of the track.
    expect(Number(slider.min) + Number(slider.max)).toBe(0)
    expect(slider.value).toBe('0')

    fireEvent.change(slider, { target: { value: '-4' } })
    expect(usePlayerStore.getState().practice?.metronomeGainDb).toBe(-4)

    const readout = screen.getByRole('button', { name: '节拍器音量（双击编辑）' })
    expect(readout.textContent).toBe('-4 dB (63%)')

    fireEvent.doubleClick(readout)
    const editor = screen.getByRole('textbox', { name: '节拍器音量' }) as HTMLInputElement
    fireEvent.change(editor, { target: { value: '3' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(usePlayerStore.getState().practice?.metronomeGainDb).toBe(3)
  })

  it('resets to unity on double click and stays bounded by the schema range', async () => {
    await openPractice()
    fireEvent.click(screen.getByRole('button', { name: '节拍器' }))

    const slider = screen.getByRole('slider', { name: '节拍器音量滑块' }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '-24' } })
    fireEvent.doubleClick(slider)
    expect(usePlayerStore.getState().practice?.metronomeGainDb).toBe(0)

    const readout = screen.getByRole('button', { name: '节拍器音量（双击编辑）' })
    fireEvent.doubleClick(readout)
    const editor = screen.getByRole('textbox', { name: '节拍器音量' }) as HTMLInputElement
    fireEvent.change(editor, { target: { value: '99' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(usePlayerStore.getState().practice?.metronomeGainDb).toBe(6)

    fireEvent.doubleClick(screen.getByRole('button', { name: '节拍器音量（双击编辑）' }))
    const again = screen.getByRole('textbox', { name: '节拍器音量' }) as HTMLInputElement
    fireEvent.change(again, { target: { value: '-99' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(usePlayerStore.getState().practice?.metronomeGainDb).toBe(-6)
  })
})
