// @vitest-environment jsdom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RehearsalRoom } from '../src/renderer/src/pages/RehearsalRoom.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { fixtureDetail, fixtureRehearsal, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { getRecordingSession, isRecordingLocked, publishRecordingState } from '../src/renderer/src/recording-session.js'
import { getAudioSession, releaseAudioSession } from '../src/renderer/src/audio-session.js'
import type { AppSettings, RecordingMeter, SongDetail } from '../packages/shared/src/domain.js'
import type { RehearsalRecordingState, RehearsalRecordingTake, RehearsalTimeline, RehearsalTimelinePosition } from '../packages/shared/src/rehearsal.js'
import { rehearsalTimelinePosition } from '../packages/shared/src/rehearsal.js'

const engine = vi.hoisted(() => ({
  configure: vi.fn(async (_configuration: { timeline: RehearsalTimeline }) => {}),
  play: vi.fn(async () => true), pause: vi.fn(), stop: vi.fn(async () => {}), seek: vi.fn(async () => {}), destroy: vi.fn(), setVisualActive: vi.fn(),
  previousItemStart: () => 0, nextItemStart: () => 5000, isPlaying: false, positionMs: 0,
  timeline: null as RehearsalTimeline | null,
  listener: null as ((position: RehearsalTimelinePosition, playing: boolean) => void) | null
}))
vi.mock('../src/renderer/src/rehearsal-audio-engine.js', () => ({ RehearsalAudioEngine: class {
  constructor() { return engine }
} }))
Object.assign(engine, { onTime: (listener: typeof engine.listener) => { engine.listener = listener }, onEnded: () => {}, onError: () => {} })
vi.mock('../src/renderer/src/components/ui/confirm.js', () => ({ confirmAction: vi.fn(async () => true), promptAction: vi.fn(async () => null) }))

let nativeState: RehearsalRecordingState
let stateListener: ((state: RehearsalRecordingState) => void) | null
let meterListener: ((meter: RecordingMeter) => void) | null
let trackId: string
let settings: AppSettings
const props = { onActiveChange: vi.fn(), onOpenSongSettings: vi.fn(), onRecordingLockChange: vi.fn(), onToast: vi.fn() }
const sendState = (patch: Partial<RehearsalRecordingState>) => {
  nativeState = { ...nativeState, ...patch }
  stateListener?.(nativeState)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.clearAllMocks()
  publishRecordingState('practice', { phase: 'idle' })
  publishRecordingState('rehearsal', { phase: 'idle' })
  stateListener = null
  meterListener = null
  engine.timeline = null
  engine.isPlaying = false
  engine.configure.mockImplementation(async ({ timeline }) => { engine.timeline = timeline })
  engine.setVisualActive.mockImplementation((active: boolean) => {
    if (active && engine.timeline) engine.listener?.(rehearsalTimelinePosition(engine.timeline, 0), false)
  })
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  trackId = (await window.bandbuddy.rehearsals.createTrack(fixtureRehearsal.id)).id
  settings = await window.bandbuddy.settings.get()
  nativeState = await window.bandbuddy.rehearsals.recordingState()
  vi.spyOn(window.bandbuddy.rehearsals, 'recordingState').mockImplementation(async () => nativeState)
  vi.spyOn(window.bandbuddy.rehearsals, 'onRecordingState').mockImplementation((listener) => { stateListener = listener; return () => { stateListener = null } })
  vi.spyOn(window.bandbuddy.rehearsals, 'onMeter').mockImplementation((listener) => { meterListener = listener; return () => { meterListener = null } })
  vi.spyOn(window.bandbuddy.rehearsals, 'startRecording').mockImplementation(async () => {
    sendState({ phase: 'recording', rehearsalId: fixtureRehearsal.id, recordingTrackId: trackId, sessionId: 'native-session', timelinePositionMs: 1000, message: '正在录音' })
    return { sessionId: 'native-session' }
  })
  vi.spyOn(window.bandbuddy.rehearsals, 'pauseRecording').mockImplementation(async () => { sendState({ phase: 'paused', message: '已暂停' }) })
  vi.spyOn(window.bandbuddy.rehearsals, 'resumeRecording').mockImplementation(async () => { sendState({ phase: 'recording', message: '正在录音' }) })
  vi.spyOn(window.bandbuddy.rehearsals, 'stopRecording').mockImplementation(async () => { sendState({ phase: 'idle', message: '' }); return null })
  vi.spyOn(window.bandbuddy.rehearsals, 'cancelRecording').mockImplementation(async () => { sendState({ phase: 'idle', message: '' }) })
})

afterEach(() => {
  cleanup()
  publishRecordingState('practice', { phase: 'idle' })
  publishRecordingState('rehearsal', { phase: 'idle' })
  const audio = getAudioSession()
  if (audio) releaseAudioSession(audio.owner)
  vi.restoreAllMocks()
})

async function openRoom() {
  const rendered = render(<RehearsalRoom {...props} settings={settings} active />)
  await screen.findByText('排练队列')
  return rendered
}
async function startRecording() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '录制', exact: true })) })
  await waitFor(() => expect(window.bandbuddy.rehearsals.startRecording).toHaveBeenCalledOnce())
}

describe('rehearsal recording survives navigation', () => {
  it('keeps native recording and stable global controls across hiding, pause/resume, settings refresh and stopping', async () => {
    const rendered = await openRoom()
    await startRecording()
    const controls = getRecordingSession()!.controls!
    engine.configure.mockClear()
    engine.pause.mockClear()
    rendered.rerender(<RehearsalRoom {...props} settings={{ ...settings, audioOutputDeviceId: 'another-output' }} active={false} />)
    expect(getRecordingSession()).toMatchObject({ owner: 'rehearsal', phase: 'recording' })
    expect(engine.configure).not.toHaveBeenCalled()
    expect(engine.pause).not.toHaveBeenCalled()
    expect(engine.destroy).not.toHaveBeenCalled()
    expect(window.bandbuddy.rehearsals.stopRecording).not.toHaveBeenCalled()
    expect(window.bandbuddy.rehearsals.cancelRecording).not.toHaveBeenCalled()

    await act(async () => { await controls.pause?.() })
    expect(window.bandbuddy.rehearsals.pauseRecording).toHaveBeenCalledOnce()
    expect(getRecordingSession()).toMatchObject({ phase: 'paused', controls })
    expect(isRecordingLocked()).toBe(true)
    await act(async () => { await controls.resume?.() })
    expect(window.bandbuddy.rehearsals.resumeRecording).toHaveBeenCalledOnce()
    expect(getRecordingSession()?.phase).toBe('recording')

    const stopResult = deferred<RehearsalRecordingTake | null>()
    vi.mocked(window.bandbuddy.rehearsals.stopRecording).mockImplementationOnce(async () => {
      sendState({ phase: 'stopping', message: '正在保存' })
      return stopResult.promise
    })
    let stopping: Promise<void> | void
    await act(async () => { stopping = controls.stop() })
    expect(getRecordingSession()?.phase).toBe('stopping')
    expect(isRecordingLocked()).toBe(true)
    expect(engine.configure).not.toHaveBeenCalled()
    await act(async () => { sendState({ phase: 'idle', message: '' }); stopResult.resolve(null); await stopping })
    expect(window.bandbuddy.rehearsals.stopRecording).toHaveBeenCalledOnce()
    expect(getRecordingSession()).toBeNull()
    expect(window.bandbuddy.rehearsals.startRecording).toHaveBeenCalledOnce()
  })

  it('suppresses hidden meter and position renders and restores the latest native position on return', async () => {
    const commits = vi.fn()
    const content = (active: boolean) => <Profiler id="rehearsal" onRender={commits}><RehearsalRoom {...props} settings={settings} active={active} /></Profiler>
    const rendered = render(content(true))
    await screen.findByText('排练队列')
    await startRecording()
    rendered.rerender(content(false))
    commits.mockClear()
    act(() => {
      for (let index = 0; index < 30; index++) {
        sendState({ phase: 'recording', timelinePositionMs: 6000 + index })
        meterListener?.({ peak: [0.87], rms: [0.4], clipped: false, sourcePositionMs: 6000 + index, recording: true })
      }
    })
    expect(commits).not.toHaveBeenCalled()
    rendered.rerender(content(true))
    expect((screen.getByRole('slider', { name: '排练总进度' }) as HTMLInputElement).value).toBe('6029')
    expect(rendered.container.querySelector<HTMLElement>('.record-track-icon i')?.style.height).toBe('87%')
    expect(window.bandbuddy.rehearsals.startRecording).toHaveBeenCalledOnce()
  })

  it.each(['starting', 'paused', 'stopping'])('blocks rehearsal playback, seeking, recording and structure changes while practice owns %s', async (phase) => {
    publishRecordingState('practice', { phase, message: '歌曲录音占用设备' })
    const rendered = await openRoom()
    expect(getRecordingSession()?.owner).toBe('practice')
    expect(screen.queryByRole('button', { name: '录制', exact: true })).toBeNull()
    for (const name of ['播放', '前进 5 秒', '停止并归零', '添加衔接', '添加录音轨']) {
      const button = screen.getByRole('button', { name, exact: true }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    const slider = screen.getByRole('slider', { name: '排练总进度' }) as HTMLInputElement
    expect(slider.disabled).toBe(true)
    fireEvent.change(slider, { target: { value: '12000' } })
    expect((screen.getByRole('textbox', { name: '编排单名称' }) as HTMLInputElement).disabled).toBe(true)
    rendered.rerender(<RehearsalRoom {...props} settings={{ ...settings, audioOutputDeviceId: 'blocked-output' }} active />)
    expect(engine.configure).not.toHaveBeenCalled()
    expect(engine.play).not.toHaveBeenCalled()
    expect(engine.seek).not.toHaveBeenCalled()
    expect(window.bandbuddy.rehearsals.startRecording).not.toHaveBeenCalled()
  })

  it('cancels a hidden recording through the registered IPC control and releases a failed recording without disabling navigation', async () => {
    const rendered = await openRoom()
    await startRecording()
    const controls = getRecordingSession()!.controls!
    rendered.rerender(<RehearsalRoom {...props} settings={settings} active={false} />)
    await act(async () => { await controls.cancel() })
    expect(window.bandbuddy.rehearsals.cancelRecording).toHaveBeenCalledOnce()
    expect(getRecordingSession()).toBeNull()
    act(() => { sendState({ phase: 'failed', error: 'DEVICE_DISCONNECTED', message: '设备断开' }) })
    expect(isRecordingLocked()).toBe(false)
    expect(props.onToast).toHaveBeenCalled()
    rendered.rerender(<RehearsalRoom {...props} settings={settings} active />)
    expect((screen.getByRole('button', { name: '播放', exact: true }) as HTMLButtonElement).disabled).toBe(false)
    expect(engine.destroy).not.toHaveBeenCalled()
  })

  it('ignores delayed initial idle state and prevents a cancelled preflight from clearing a newly started reservation', async () => {
    const initial = deferred<RehearsalRecordingState>()
    vi.mocked(window.bandbuddy.rehearsals.recordingState).mockReturnValueOnce(initial.promise)
    await openRoom()
    const get = vi.spyOn(window.bandbuddy.library, 'get')
    const first = deferred<SongDetail | null>()
    get.mockReturnValueOnce(first.promise)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '录制', exact: true })) })
    expect(getRecordingSession()?.phase).toBe('starting')
    await act(async () => { initial.resolve(nativeState) })
    expect(getRecordingSession()?.phase).toBe('starting')
    await act(async () => { await getRecordingSession()!.controls!.cancel() })
    expect(isRecordingLocked()).toBe(false)
    expect(window.bandbuddy.rehearsals.startRecording).not.toHaveBeenCalled()

    const second = deferred<SongDetail | null>()
    get.mockReturnValueOnce(second.promise)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '录制', exact: true })) })
    expect(getRecordingSession()?.phase).toBe('starting')
    await act(async () => { first.resolve(fixtureDetail(fixtureSongs[0]!)) })
    expect(getRecordingSession()?.phase).toBe('starting')
    expect(window.bandbuddy.rehearsals.startRecording).not.toHaveBeenCalled()
    await act(async () => { second.resolve(fixtureDetail(fixtureSongs[0]!)) })
    await waitFor(() => expect(window.bandbuddy.rehearsals.startRecording).toHaveBeenCalledOnce())
    expect(getRecordingSession()).toMatchObject({ owner: 'rehearsal', phase: 'recording' })
  })

  it('clears a failed native recording while hidden and restores usable playback controls', async () => {
    const rendered = await openRoom()
    await startRecording()
    rendered.rerender(<RehearsalRoom {...props} settings={settings} active={false} />)
    act(() => { sendState({ phase: 'failed', error: 'DEVICE_DISCONNECTED', message: '声卡已断开' }) })
    expect(getRecordingSession()).toBeNull()
    expect(isRecordingLocked()).toBe(false)
    expect(props.onToast).toHaveBeenCalled()
    rendered.rerender(<RehearsalRoom {...props} settings={settings} active />)
    expect((screen.getByRole('button', { name: '播放', exact: true }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('button', { name: '录制', exact: true })).toBeTruthy()
    expect(engine.destroy).not.toHaveBeenCalled()
  })

  it('retries cancellation when the native preparation acknowledgement arrives after an earlier empty cancel', async () => {
    const started = deferred<{ sessionId: string }>()
    vi.mocked(window.bandbuddy.rehearsals.startRecording).mockReturnValueOnce(started.promise)
    vi.mocked(window.bandbuddy.rehearsals.cancelRecording).mockResolvedValueOnce(undefined)
    await openRoom()
    await startRecording()
    expect(getRecordingSession()?.phase).toBe('starting')
    await act(async () => { await getRecordingSession()!.controls!.cancel() })
    expect(window.bandbuddy.rehearsals.cancelRecording).toHaveBeenCalledOnce()
    expect(isRecordingLocked()).toBe(true)
    await act(async () => {
      sendState({ phase: 'preparing', rehearsalId: fixtureRehearsal.id, recordingTrackId: trackId, sessionId: 'late-native', message: '准备中' })
    })
    expect(window.bandbuddy.rehearsals.cancelRecording).toHaveBeenCalledTimes(2)
    await act(async () => { started.reject(new Error('RECORDING_CANCELLED')) })
    expect(getRecordingSession()).toBeNull()
    expect(window.bandbuddy.rehearsals.resumeRecording).not.toHaveBeenCalled()
  })
})
