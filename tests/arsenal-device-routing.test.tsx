// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArsenalMonitorState } from '../packages/shared/src/arsenal.js'
import { defaultEffectChain } from '../packages/shared/src/arsenal.js'
import { ArsenalPage } from '../src/renderer/src/pages/ArsenalPage.js'
import { reconfigureArsenalAudio } from '../src/renderer/src/arsenal/audio-routing.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

const active: ArsenalMonitorState = { active: true, mode: 'wet', sampleRate: 44100, bufferFrames: 128, latencyMs: 2.9, peak: [.2], outputPeak: .4, xruns: 0, error: null }
beforeEach(() => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  Element.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('arsenal audio reconfiguration', () => {
  it('stops, saves only the latest audio snapshot, and resumes the latest effect chain', async () => {
    const api = window.bandbuddy
    const settings = { ...await api.settings.get(), libraryRoot: '最新中文目录', recordingAudio: { ...(await api.settings.get()).recordingAudio, alignmentOffsetMs: 19 } }
    const order: string[] = []
    let chain = defaultEffectChain()
    vi.spyOn(api.settings, 'get').mockResolvedValue(settings)
    vi.spyOn(api.arsenal, 'monitorState').mockResolvedValue(active)
    const monitor = vi.spyOn(api.arsenal, 'monitor').mockImplementation(async request => { order.push(request.mode); return { ...active, active: request.mode !== 'off', mode: request.mode } })
    const update = vi.spyOn(api.settings, 'update')
    const reconcile = vi.spyOn(api.settings, 'reconcileAudio').mockImplementation(async request => {
      order.push('save')
      chain = { ...chain, outputGainDb: -12 }
      return { ...settings, audioOutputDeviceId: request.audioOutputDeviceId, recordingAudio: request.recordingAudio }
    })
    const saved = await reconfigureArsenalAudio(api, current => ({ ...current, bufferFrames: 256 }), () => chain)
    expect(order).toEqual(['off', 'save', 'wet'])
    expect(saved.libraryRoot).toBe('最新中文目录')
    expect(saved.recordingAudio).toMatchObject({ bufferFrames: 256, alignmentOffsetMs: 19 })
    expect(reconcile.mock.calls[0]?.[0].expected.recordingAudio).toBe(settings.recordingAudio)
    expect(update).not.toHaveBeenCalled()
    expect(monitor.mock.calls.at(-1)?.[0].chain.outputGainDb).toBe(-12)
  })

  it('leaves monitoring off after a concurrent settings edit instead of overwriting it', async () => {
    const api = window.bandbuddy
    const latest = await api.settings.get()
    vi.spyOn(api.arsenal, 'monitorState').mockResolvedValue(active)
    const monitor = vi.spyOn(api.arsenal, 'monitor').mockResolvedValue({ ...active, active: false, mode: 'off' })
    vi.spyOn(api.settings, 'reconcileAudio').mockResolvedValue({ ...latest, recordingAudio: { ...latest.recordingAudio, bufferFrames: 512 } })
    await expect(reconfigureArsenalAudio(api, current => ({ ...current, bufferFrames: 256 }), defaultEffectChain)).rejects.toThrow('其他窗口')
    expect(monitor).toHaveBeenCalledExactlyOnceWith({ mode: 'off', chain: defaultEffectChain() })
  })

  it('does not change settings if shutting down the current stream failed', async () => {
    const api = window.bandbuddy
    vi.spyOn(api.arsenal, 'monitorState').mockResolvedValue(active)
    vi.spyOn(api.arsenal, 'monitor').mockRejectedValue(new Error('设备忙'))
    const save = vi.spyOn(api.settings, 'reconcileAudio')
    await expect(reconfigureArsenalAudio(api, current => ({ ...current, sampleRate: 48000 }), defaultEffectChain)).rejects.toThrow('设备忙')
    expect(save).not.toHaveBeenCalled()
  })

  it('does not restart an interrupted device edit after leaving the page', async () => {
    const api = window.bandbuddy
    let mounted = true
    vi.spyOn(api.arsenal, 'monitorState').mockResolvedValue(active)
    const monitor = vi.spyOn(api.arsenal, 'monitor').mockImplementation(async request => { mounted = false; return { ...active, active: false, mode: request.mode } })
    const save = vi.spyOn(api.settings, 'reconcileAudio')
    await reconfigureArsenalAudio(api, current => ({ ...current, bufferFrames: 256 }), defaultEffectChain, () => mounted)
    expect(monitor).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
  })
})

it('shows real monitor readings, edits the buffer with the custom select, and reopens the sidebar', async () => {
  const api = window.bandbuddy
  const callbacks = new Set<(state: ArsenalMonitorState) => void>()
  let monitorState = active
  vi.spyOn(api.arsenal, 'monitorState').mockImplementation(async () => monitorState)
  vi.spyOn(api.arsenal, 'onMonitor').mockImplementation(callback => { callbacks.add(callback); return () => { callbacks.delete(callback) } })
  vi.spyOn(api.arsenal, 'monitor').mockImplementation(async request => { monitorState = { ...monitorState, active: request.mode !== 'off', mode: request.mode }; callbacks.forEach(callback => callback(monitorState)); return monitorState })
  let settings = await api.settings.get()
  vi.spyOn(api.settings, 'get').mockImplementation(async () => settings)
  const reconcile = vi.spyOn(api.settings, 'reconcileAudio').mockImplementation(async request => { settings = { ...settings, recordingAudio: request.recordingAudio }; return settings })
  render(<ArsenalPage onToast={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('meter', { name: '实时输出电平' }).getAttribute('aria-valuenow')).toBe('40'))
  expect(screen.getByText(/44\.1 kHz · 128 frames · 2\.9 ms/)).toBeTruthy()
  act(() => callbacks.forEach(callback => callback({ ...active, outputPeak: .72 })))
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('72')
  fireEvent.click(screen.getByRole('combobox', { name: '实时缓冲区' }))
  fireEvent.click(screen.getByRole('option', { name: '256 frames' }))
  await waitFor(() => expect(reconcile).toHaveBeenCalled())
  expect(reconcile.mock.calls[0]?.[0].recordingAudio.bufferFrames).toBe(256)
  fireEvent.click(screen.getByRole('button', { name: '收起预设' }))
  expect(screen.getByRole('main').classList.contains('is-sidebar-collapsed')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '展开预设' }))
  expect(screen.getByRole('main').classList.contains('is-sidebar-collapsed')).toBe(false)
})

it('uses the selected duplex device capabilities and its saved alignment calibration', async () => {
  const api = window.bandbuddy
  const saved = await api.settings.get()
  const settings = { ...saved, recordingAudio: { ...saved.recordingAudio, sampleRate: 44100, inputChannels: [5], alignmentOffsetMs: 19, deviceAlignmentOffsets: { 'coreaudio|usb|usb': 7 } } }
  vi.spyOn(api.settings, 'get').mockResolvedValue(settings)
  vi.spyOn(api.recording, 'devices').mockResolvedValue([{ id: 'usb', name: 'USB 声卡', backend: 'coreaudio', inputChannels: 2, outputChannels: 2, duplexChannels: 2, sampleRates: [48000], preferredSampleRate: 48000, defaultInput: false, defaultOutput: false }])
  const reconcile = vi.spyOn(api.settings, 'reconcileAudio').mockImplementation(async request => ({ ...settings, recordingAudio: request.recordingAudio }))
  render(<ArsenalPage onToast={vi.fn()} />)
  await waitFor(() => expect((screen.getByRole('combobox', { name: '实时音频设备' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('combobox', { name: '实时音频设备' }))
  fireEvent.click(screen.getByRole('option', { name: 'USB 声卡 · coreaudio' }))
  await waitFor(() => expect(reconcile).toHaveBeenCalled())
  expect(reconcile.mock.calls[0]?.[0].recordingAudio).toMatchObject({ backend: 'coreaudio', inputDeviceId: 'usb', outputDeviceId: 'usb', sampleRate: 0, inputChannels: [0], alignmentOffsetMs: 7 })
})
