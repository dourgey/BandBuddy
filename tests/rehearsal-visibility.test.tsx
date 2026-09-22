// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RehearsalRoom } from '../src/renderer/src/pages/RehearsalRoom.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { rehearsalTimelinePosition, type RehearsalTimeline, type RehearsalTimelinePosition } from '../packages/shared/src/rehearsal.js'
import { getAudioSession, pauseAudioSession } from '../src/renderer/src/audio-session.js'
import { applyAppearance } from '../src/renderer/src/appearance.js'

const engine = vi.hoisted(() => ({
  construct: vi.fn(), configure: vi.fn(), play: vi.fn(async () => true), pause: vi.fn(), stop: vi.fn(async () => {}), destroy: vi.fn(), setVisualActive: vi.fn(),
  isPlaying: false, positionMs: 0, listener: null as ((position: RehearsalTimelinePosition, playing: boolean) => void) | null,
  timeline: null as RehearsalTimeline | null
}))
vi.mock('../src/renderer/src/rehearsal-audio-engine.js', () => ({ RehearsalAudioEngine: class {
  constructor() { engine.construct(); return engine }
} }))
Object.assign(engine, { onTime: (listener: typeof engine.listener) => { engine.listener = listener }, onEnded: () => {}, onError: () => {} })

beforeEach(() => {
  vi.clearAllMocks()
  engine.isPlaying = false
  engine.configure.mockImplementation(async (configuration: { timeline: RehearsalTimeline }) => { engine.timeline = configuration.timeline })
  engine.play.mockImplementation(async () => { engine.isPlaying = true; engine.listener?.(rehearsalTimelinePosition(engine.timeline!, 1000), true); return true })
  engine.pause.mockImplementation(() => { engine.isPlaying = false; engine.listener?.(rehearsalTimelinePosition(engine.timeline!, 1000), false) })
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
})
afterEach(() => { cleanup(); pauseAudioSession(); vi.restoreAllMocks() })
const props = { onActiveChange: vi.fn(), onOpenSongSettings: vi.fn(), onRecordingLockChange: vi.fn(), onToast: vi.fn() }

describe('rehearsal kept-alive visibility', () => {
  it('keeps engine and playing position across hiding/theme, suspends hidden UI updates, and restores latest time', async () => {
    const rendered = render(<RehearsalRoom {...props} active />)
    await screen.findByText('排练队列')
    await waitFor(() => expect(engine.configure).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '播放', exact: true }))
    await screen.findByRole('button', { name: '暂停', exact: true })
    expect(getAudioSession()?.owner).toBe('rehearsal')
    const configurations = engine.configure.mock.calls.length
    rendered.rerender(<RehearsalRoom {...props} active={false} />)
    act(() => { applyAppearance({ theme: 'dark' }); engine.listener?.(rehearsalTimelinePosition(engine.timeline!, 5000), true) })
    expect((screen.getByRole('slider', { name: '排练总进度' }) as HTMLInputElement).value).toBe('1000')
    expect(engine.pause).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    expect(engine.configure).toHaveBeenCalledTimes(configurations)
    rendered.rerender(<RehearsalRoom {...props} active />)
    expect((screen.getByRole('slider', { name: '排练总进度' }) as HTMLInputElement).value).toBe('5000')
    expect(engine.construct).toHaveBeenCalledTimes(1)
    act(() => pauseAudioSession())
    expect(engine.pause).toHaveBeenCalledOnce()
  })

  it('collapses material on a narrow viewport and preserves the user expansion choice after resize', async () => {
    const previousWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    const rendered = render(<RehearsalRoom {...props} />)
    const toggle = await screen.findByRole('button', { name: '展开曲库素材' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起曲库素材' }).getAttribute('aria-expanded')).toBe('true')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 })
    fireEvent(window, new Event('resize'))
    expect(screen.getByRole('button', { name: '收起曲库素材' }).getAttribute('aria-expanded')).toBe('true')
    rendered.unmount()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
  })
})
