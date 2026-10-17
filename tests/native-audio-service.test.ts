import { describe, expect, it, vi } from 'vitest'
import { NativeAudioService } from '../src/main/native-audio.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'

function setup() {
  const song = fixtureDetail(fixtureSongs[0]!), emit = vi.fn()
  let active = true
  const host = {
    onEvent: vi.fn(), activeSampleRate: () => active ? 48000 : null,
    isPlaybackOnly: () => active, isTestSession: () => active, clearTimeline: vi.fn(),
    stopTest: vi.fn(async () => { active = false }),
    timeline: vi.fn(async () => ({ positionMs: 1700, playing: false, ended: false, generation: 1, countInRemaining: 0, underruns: 0, error: '' }))
  }
  const service = new NativeAudioService({} as never, {} as never, {} as never, host as never, {} as never, emit)
  Object.assign(service, { song, practice: song.practice })
  return { service, host, emit, song }
}
describe('native playback lifetime', () => {
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
    host.isPlaybackOnly = () => false; host.isTestSession = () => false
    await service.update({ ...song.practice, masterGainDb: -6 })
    await service.command('pause')
    await expect(service.command('play')).rejects.toThrow('录音进行中')
    await service.command('unload')
    expect(host.timeline).not.toHaveBeenCalled()
    expect(host.stopTest).not.toHaveBeenCalled()
  })
})
