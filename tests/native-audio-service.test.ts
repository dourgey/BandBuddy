import { describe, expect, it, vi } from 'vitest'
import { NativeAudioService } from '../src/main/native-audio.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { createDefaultRecordingTrackState, type RecordingTake } from '../packages/shared/src/domain.js'

function setup() {
  const song = fixtureDetail(fixtureSongs[0]!), emit = vi.fn()
  let active = true
  const host = {
    onEvent: vi.fn(), activeSampleRate: () => active ? 48000 : null,
    isPlaybackOnly: () => active, isTestSession: () => active, hasActiveTimeline: () => active, clearTimeline: vi.fn(),
    stopTest: vi.fn(async () => { active = false }),
    timeline: vi.fn(async (_params: Record<string, unknown>) => ({ positionMs: 1700, playing: false, ended: false, generation: 1, countInRemaining: 0, underruns: 0, error: '' }))
  }
  const service = new NativeAudioService({} as never, {} as never, {} as never, host as never, {} as never, emit)
  Object.assign(service, { song, practice: song.practice })
  return { service, host, emit, song }
}
describe('native playback lifetime', () => {
  it('updates recording M/S without waiting for or restarting the current tone render', async () => {
    const { service, host, song } = setup()
    song.recordingTracks = [{ ...createDefaultRecordingTrackState(song.id, 'record'), activeTakeId: 'take', solo: true }]
    song.recordingTakes = [{ id: 'take', previewMediaUrl: 'bandbuddy-media://song/a/recording-preview/b?effects=first' } as RecordingTake]
    Object.assign(service, { database: { getSong: () => song } })
    let finish!: () => void
    const load = vi.spyOn(service as unknown as { loadNow(): Promise<void> }, 'loadNow').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const tone = service.refresh(song.id)
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    song.recordingTracks[0]!.muted = true
    song.recordingTakes[0]!.previewMediaUrl = 'bandbuddy-media://song/a/recording-preview/b?effects=second'
    const mix = service.refresh(song.id)
    expect(host.timeline).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'update', state: expect.objectContaining({ tracks: expect.arrayContaining([{ id: 'record', gain: 0 }]) }) }))
    expect(load).toHaveBeenCalledOnce()
    finish(); await Promise.all([tone, mix])
    expect(load).toHaveBeenCalledOnce()
  })
  it('keeps stem solo, master and EQ live while a recording source is being prepared', async () => {
    const { service, host, song } = setup()
    Object.assign(service, { preparingSources: true, serial: new Promise(() => {}) })
    const practice = { ...song.practice, masterGainDb: -6, tracks: song.practice.tracks.map(t => ({ ...t, solo: t.stemType === 'vocals' })) }
    await service.update(practice)
    expect(host.timeline).toHaveBeenCalledExactlyOnceWith({ action: 'update', state: expect.objectContaining({
      masterGain: expect.closeTo(.501187), tracks: expect.arrayContaining([{ id: 'drums', gain: 0 }])
    }) })
  })
  it('rebuilds the saved recording timeline when monitoring reopened an empty device', async () => {
    const { service, host } = setup()
    let loaded = false
    host.isPlaybackOnly = () => false
    host.hasActiveTimeline = () => loaded
    const load = vi.spyOn(service as unknown as { loadNow(): Promise<void> }, 'loadNow').mockImplementation(async () => { loaded = true })
    await service.command('pause')
    expect(host.timeline).not.toHaveBeenCalled()
    await service.command('play')
    expect(load).toHaveBeenCalledOnce()
    expect(host.timeline).toHaveBeenCalledExactlyOnceWith({ action: 'play' })
  })
  it('coalesces pending EQ edits and sends only the latest EQ without mixer or transport changes', async () => {
    const { service, host, song } = setup()
    const updates = Array.from({ length: 200 }, (_, i) => service.update({ ...song.practice,
      eq: { ...song.practice.eq, enabled: true, mode: 'parametric', nodes: [{ id: 'node', frequency: 20 + i * 80, gainDb: 6, q: 1 }] }
    }))
    await Promise.all(updates)
    expect(host.timeline).toHaveBeenCalledExactlyOnceWith({ action: 'update', state: { eq: expect.objectContaining({ nodes: [{ id: 'node', frequency: 15940, gainDb: 6, q: 1 }] }) } })
    await service.update({ ...song.practice, eq: { ...song.practice.eq, enabled: true } })
    expect(host.timeline.mock.calls[1]![0]).toEqual({ action: 'update', state: { eq: { ...song.practice.eq, enabled: true } } })
  })
  it('does not coalesce EQ changes across a seek command', async () => {
    const { service, host, song } = setup()
    const first = { ...song.practice, eq: { ...song.practice.eq, enabled: true } }
    const second = { ...first, eq: { ...first.eq, mode: 'parametric' as const } }
    await Promise.all([service.update(first), service.command('seek', { positionMs: 2300 }), service.update(second)])
    expect(host.timeline.mock.calls.map(call => call[0])).toEqual([
      { action: 'update', state: { eq: first.eq } }, { action: 'seek', positionMs: 2300 }, { action: 'update', state: { eq: second.eq } }
    ])
  })
  it('releases a playback-only device on pause and seeks while closed without reopening it', async () => {
    const { service, host, emit, song } = setup()
    await service.command('pause')
    expect(host.stopTest).toHaveBeenCalledOnce()
    await service.command('seek', { positionMs: 2400 })
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ positionMs: 2400, playing: false }))
    await service.update({ ...song.practice, masterGainDb: -12, positionMs: 2400 })
    expect(host.timeline).toHaveBeenCalledOnce()
    await service.command('unload')
    expect(host.clearTimeline).toHaveBeenCalledOnce()
  })
  it('does not close a shared monitoring stream when playback pauses', async () => {
    const { service, host } = setup()
    host.isPlaybackOnly = () => false
    await service.command('pause')
    expect(host.stopTest).not.toHaveBeenCalled()
    await service.command('unload')
    expect(host.timeline).toHaveBeenLastCalledWith({ action: 'unload' })
    expect(host.stopTest).not.toHaveBeenCalled()
  })
  it('keeps practice updates and transport commands out of an active formal recording', async () => {
    const { service, host, song } = setup()
    host.isPlaybackOnly = () => false; host.isTestSession = () => false; host.hasActiveTimeline = () => false
    await service.update({ ...song.practice, masterGainDb: -6 })
    await service.command('pause')
    await expect(service.command('play')).rejects.toThrow('录音进行中')
    await service.command('unload')
    expect(host.timeline).not.toHaveBeenCalled()
    expect(host.stopTest).not.toHaveBeenCalled()
  })
})
