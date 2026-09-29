// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Metronome } from '../src/renderer/src/woodshed/Metronome.js'
const audio = vi.hoisted(() => ({ start: vi.fn(async () => true), stop: vi.fn(), destroy: vi.fn(), update: vi.fn(), setOutput: vi.fn(async () => {}), pulse: vi.fn(() => null) }))
vi.mock('../src/renderer/src/woodshed/metronome-engine.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/woodshed/metronome-engine.js')>(),
  MetronomeEngine: class { constructor() { return audio } }
}))
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal('matchMedia', () => ({ matches: false })) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('mechanical metronome controls', () => {
  it('keeps advanced controls hidden, then exposes a working six-beat meter', () => {
    render(<Metronome outputDeviceId="" onError={vi.fn()} />)
    expect(screen.queryByLabelText('细分')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '拍号', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '6/8', exact: true }))
    expect(screen.getByRole('button', { name: '拍号', exact: true }).textContent).toContain('6/8')
    expect(screen.getByLabelText('拍点指示').children).toHaveLength(6)
  })
  it('supports precise, accelerated and wheel adjustment and persists it', () => {
    render(<Metronome outputDeviceId="" onError={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '提高速度' }))
    fireEvent.click(screen.getByRole('button', { name: '降低速度' }), { shiftKey: true })
    const knob = screen.getByRole('slider', { name: '速度旋钮' })
    fireEvent.wheel(knob, { deltaY: -1 })
    fireEvent.keyDown(knob, { key: 'ArrowUp', shiftKey: true })
    expect(knob.getAttribute('aria-valuenow')).toBe('122')
    expect(JSON.parse(localStorage.getItem('bandbuddy.metronome.v1')!).bpm).toBe(122)
  })
  it('averages taps and resets an old tap sequence', () => {
    render(<Metronome outputDeviceId="" onError={vi.fn()} />)
    const now = vi.spyOn(performance, 'now')
    const tap = screen.getByRole('button', { name: 'TAP 设置速度' })
    now.mockReturnValue(1000); fireEvent.click(tap)
    now.mockReturnValue(1600); fireEvent.click(tap)
    expect(screen.getByRole('slider', { name: '速度旋钮' }).getAttribute('aria-valuenow')).toBe('100')
    now.mockReturnValue(5000); fireEvent.click(tap)
    expect(screen.getByText('继续点击 TAP，设定速度')).toBeTruthy()
  })
})
