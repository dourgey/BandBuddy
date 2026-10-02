// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Waveform } from '../src/renderer/src/components/Waveform.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'
const waves = vi.hoisted(() => ({ create: vi.fn(), setOptions: vi.fn(), destroy: vi.fn() }))
vi.mock('wavesurfer.js', () => ({ default: { create: waves.create } }))
beforeEach(() => {
  vi.clearAllMocks()
  waves.create.mockReturnValue({ setOptions: waves.setOptions, zoom: vi.fn(), setScrollTime: vi.fn(), destroy: waves.destroy })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ min: [-1, -2], max: [1, 2] }) })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); usePlayerStore.getState().setCurrentMs(0) })
describe('waveform rendering', () => {
  it('updates appearance without rebuilding decoded peaks and moves the playhead at full precision', async () => {
    const props = { stemType: 'vocals' as const, peaksUrl: 'render-theme', color: '#112233', durationMs: 10000, loopStartMs: null, loopEndMs: null, zoom: 1, scroll: 0, onSeek: vi.fn(), onRange: vi.fn(), onViewChange: vi.fn() }
    const { container, rerender } = render(<Waveform {...props} />)
    await waitFor(() => expect(waves.create).toHaveBeenCalledOnce())
    rerender(<Waveform {...props} color="#aabbcc" />)
    expect(waves.setOptions).toHaveBeenCalledWith({ waveColor: '#aabbcc78', progressColor: '#aabbcc78' })
    expect(waves.create).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    act(() => usePlayerStore.getState().setCurrentMs(1234.5))
    expect(Number.parseFloat((container.querySelector('.wave-cursor') as HTMLElement).style.left)).toBeCloseTo(12.345)
    expect(waves.create).toHaveBeenCalledOnce()
  })
})
