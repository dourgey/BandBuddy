// @vitest-environment jsdom
import { publishRecordingState } from '../src/renderer/src/recording-session.js'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TransportFrame } from '../src/renderer/src/woodshed/audio.js'
import type { LabEvent } from '../src/renderer/src/woodshed/ensemble.js'

interface AudioMock {
  play: Mock
  pause: Mock
  stop: Mock
  destroy: Mock
  setVisualActive: Mock
  getFrame(): TransportFrame
  emit(frame: Partial<TransportFrame>): void
}
interface EnsembleMock {
  play: Mock
  stop: Mock
  destroy: Mock
  setVisualActive: Mock
  end: (() => void) | null
}
const instances = vi.hoisted(() => ({ woodshed: [] as AudioMock[], ensemble: [] as EnsembleMock[] }))

vi.mock('../src/renderer/src/woodshed/audio.js', () => {
  const idle: TransportFrame = { playing: false, eventId: null, beat: 0, bar: 1, round: 1, bpm: 70, countIn: 0, hidden: false }
  class WoodshedAudio {
    current = { ...idle }
    listener: (frame: TransportFrame) => void = () => {}
    constructor() { instances.woodshed.push(this) }
    onFrame = vi.fn((listener: (frame: TransportFrame) => void) => { this.listener = listener })
    getFrame = () => this.current
    emit = (frame: Partial<TransportFrame>) => { this.current = { ...this.current, ...frame }; this.listener(this.current) }
    setVisualActive = vi.fn()
    setOutput = vi.fn(async () => {})
    setReference = vi.fn()
    play = vi.fn(async () => { this.emit({ playing: true }) })
    preview = vi.fn(async () => {})
    previewEvent = vi.fn(async () => {})
    drone = vi.fn(async () => {})
    pause = vi.fn(() => this.emit({ playing: false }))
    stop = vi.fn(() => { this.current = { ...idle }; this.listener(this.current) })
    destroy = vi.fn()
  }
  return { WoodshedAudio, IDLE_FRAME: idle }
})
vi.mock('../src/renderer/src/woodshed/ensemble-audio.js', () => {
  class EnsembleAudio {
    end: (() => void) | null = null
    constructor() { instances.ensemble.push(this) }
    setVisualActive = vi.fn()
    setOutput = vi.fn(async () => {})
    play = vi.fn(async (_events: LabEvent[], _beats: number, _bpm: number, _rounds: number, _a4: number, _onFrame: unknown, onEnd: () => void) => { this.end = onEnd })
    preview = vi.fn(async () => {})
    previewChord = vi.fn(async () => {})
    stop = vi.fn()
    destroy = vi.fn()
  }
  return { EnsembleAudio }
})
vi.mock('../src/renderer/src/woodshed/Score.js', () => ({ Score: () => null }))
vi.mock('../src/renderer/src/woodshed/PianoScore.js', () => ({ PianoScore: () => null }))
vi.mock('../src/renderer/src/woodshed/ViolinScore.js', () => ({ ViolinScore: () => null }))
vi.mock('../src/renderer/src/woodshed/Tuner.js', () => ({ Tuner: () => null }))

import WoodshedPage from '../src/renderer/src/pages/WoodshedPage.js'
import { Workbench } from '../src/renderer/src/woodshed/Workbench.js'
import { PianoWorkbench } from '../src/renderer/src/woodshed/PianoWorkbench.js'
import { EnsembleWorkbench } from '../src/renderer/src/woodshed/EnsembleWorkbench.js'
import { WoodshedAudio } from '../src/renderer/src/woodshed/audio.js'
import { defaults } from '../src/renderer/src/woodshed/preferences.js'
import { TUNINGS } from '../src/renderer/src/woodshed/theory.js'
import { getAudioSession, releaseAudioSession } from '../src/renderer/src/audio-session.js'

beforeEach(() => {
  instances.woodshed.length = 0
  instances.ensemble.length = 0
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  const session = getAudioSession()
  if (session) releaseAudioSession(session.owner)
})

describe('woodshed visibility preserves playback', () => {
  it('removes hidden guitar shortcuts without stopping audio, and restores controls on return', async () => {
    const audio = new WoodshedAudio()
    const engine = instances.woodshed[0]!
    const props = { audio, preferences: defaults(), tuning: TUNINGS[0]!, patch: vi.fn(), onLabels: vi.fn(), onError: vi.fn(), metronomeOnly: true }
    const { rerender, unmount } = render(<Workbench {...props} visible />)
    await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }) })
    expect(engine.play).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '暂停练习' })).toBeTruthy()
    engine.stop.mockClear()
    rerender(<Workbench {...props} visible={false} />)
    expect(engine.setVisualActive).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(document.body, { code: 'Space' })
    fireEvent.keyDown(document.body, { code: 'Home' })
    expect(engine.play).toHaveBeenCalledOnce()
    expect(engine.pause).not.toHaveBeenCalled()
    expect(engine.stop).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    expect(getAudioSession()?.owner).toBe('woodshed')

    rerender(<Workbench {...props} visible />)
    expect(engine.setVisualActive).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: '暂停练习' })).toBeTruthy()
    await act(async () => { fireEvent.keyDown(document.body, { code: 'Space' }) })
    expect(engine.pause).toHaveBeenCalledOnce()
    unmount()
    expect(engine.stop).toHaveBeenCalledOnce()
  })

  it('accepts a terminal guitar frame while hidden and returns with a stopped transport', async () => {
    const audio = new WoodshedAudio()
    const engine = instances.woodshed[0]!
    const props = { audio, preferences: defaults(), tuning: TUNINGS[0]!, patch: vi.fn(), onLabels: vi.fn(), onError: vi.fn(), metronomeOnly: true }
    const { rerender } = render(<Workbench {...props} visible />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始练习' })) })
    rerender(<Workbench {...props} visible={false} />)
    act(() => engine.emit({ playing: false, eventId: null }))
    expect(getAudioSession()).toBeNull()
    rerender(<Workbench {...props} visible />)
    expect(screen.getByRole('button', { name: '开始练习' })).toBeTruthy()
    expect(engine.play).toHaveBeenCalledOnce()
  })

  it('keeps the piano engine and playback state through visibility changes, including background completion', async () => {
    const props = { config: defaults().piano, onChange: vi.fn(), outputDeviceId: '', a4: 440, onError: vi.fn() }
    const { rerender, unmount } = render(<PianoWorkbench {...props} visible />)
    const engine = instances.ensemble[0]!
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '播放钢琴示范' })) })
    engine.stop.mockClear()
    rerender(<PianoWorkbench {...props} visible={false} />)
    expect(engine.setVisualActive).toHaveBeenLastCalledWith(false)
    expect(engine.stop).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    rerender(<PianoWorkbench {...props} visible />)
    expect(instances.ensemble).toHaveLength(1)
    expect(screen.getByRole('button', { name: '停止钢琴示范' })).toBeTruthy()
    rerender(<PianoWorkbench {...props} visible={false} />)
    act(() => engine.end?.())
    rerender(<PianoWorkbench {...props} visible />)
    expect(screen.getByRole('button', { name: '播放钢琴示范' })).toBeTruthy()
    expect(engine.play).toHaveBeenCalledOnce()
    unmount()
    expect(engine.destroy).toHaveBeenCalledOnce()
  })

  it('preserves the drum engine while hidden and handles its natural end', async () => {
    const props = { kind: 'drums' as const, p: defaults(), onChange: vi.fn(), audio: null, outputDeviceId: '', onError: vi.fn() }
    const { rerender, unmount } = render(<EnsembleWorkbench {...props} visible />)
    const engine = instances.ensemble[0]!
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '播放示范' })) })
    engine.stop.mockClear()
    rerender(<EnsembleWorkbench {...props} visible={false} />)
    expect(engine.setVisualActive).toHaveBeenLastCalledWith(false)
    expect(engine.stop).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    rerender(<EnsembleWorkbench {...props} visible />)
    expect(instances.ensemble).toHaveLength(1)
    expect(screen.getByRole('button', { name: '停止示范' })).toBeTruthy()
    rerender(<EnsembleWorkbench {...props} visible={false} />)
    act(() => engine.end?.())
    rerender(<EnsembleWorkbench {...props} visible />)
    expect(screen.getByRole('button', { name: '播放示范' })).toBeTruthy()
    unmount()
    expect(engine.destroy).toHaveBeenCalledOnce()
  })

  it('passes page activity into a retained workbench without recreating or stopping its audio engine', async () => {
    const props = { onToast: vi.fn() }
    const { rerender, unmount } = render(<WoodshedPage {...props} active />)
    const engine = instances.woodshed[0]!
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始练习' })) })
    engine.stop.mockClear()
    rerender(<WoodshedPage {...props} active={false} />)
    expect(engine.setVisualActive).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(document.body, { code: 'Home' })
    expect(engine.stop).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    rerender(<WoodshedPage {...props} active />)
    expect(instances.woodshed).toHaveLength(1)
    expect(engine.setVisualActive).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: '暂停练习' })).toBeTruthy()
    unmount()
    expect(engine.destroy).toHaveBeenCalledOnce()
  })
})


describe('recording guards across woodshed audio tools', () => {
  afterEach(() => { publishRecordingState('practice', { phase: 'idle' }); publishRecordingState('rehearsal', { phase: 'idle' }) })
  it.each(['practice', 'rehearsal'] as const)('blocks guitar, piano, and drum starts during %s recording', async owner => {
    publishRecordingState(owner, { phase: 'recording' })
    const audio = new WoodshedAudio()
    const p = defaults()
    render(<><Workbench audio={audio} preferences={p} tuning={TUNINGS[0]!} patch={vi.fn()} onLabels={vi.fn()} onError={vi.fn()} metronomeOnly /><PianoWorkbench config={p.piano} onChange={vi.fn()} outputDeviceId="" a4={440} onError={vi.fn()} /><EnsembleWorkbench kind="drums" p={p} onChange={vi.fn()} audio={audio} outputDeviceId="" onError={vi.fn()} /></>)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始练习' }))
      fireEvent.click(screen.getByRole('button', { name: '播放钢琴示范' }))
      fireEvent.click(screen.getByRole('button', { name: '播放示范' }))
      fireEvent.keyDown(document.body, { code: 'Space' })
    })
    for (const engine of [...instances.woodshed, ...instances.ensemble]) expect(engine.play).not.toHaveBeenCalled()
  })
})
