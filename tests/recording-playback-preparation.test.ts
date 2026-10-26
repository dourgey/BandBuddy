// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { MultiTrackAudioEngine } from '../src/renderer/src/audio-engine.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
afterEach(() => { Object.defineProperty(window, 'bandbuddy', { configurable: true, value: undefined }) })
it.each([false, true])('waits for saved takes before playing and respects pause=%s during preparation', async pause => {
  let finish!: () => void
  const native = { enabled: async () => true, onState: () => () => {}, load: vi.fn(async () => {}), update: vi.fn(async () => {}),
    refresh: vi.fn(() => new Promise<void>(resolve => { finish = resolve })), play: vi.fn(async () => {}), pause: vi.fn(async () => {}), unload: vi.fn(async () => {}) }
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { nativeAudio: native } })
  const engine = new MultiTrackAudioEngine({ nativeTransport: true })
  const song = fixtureDetail(fixtureSongs[0]!)
  try {
    await engine.load(song)
    const refresh = engine.updateRecordingSources(song)
    await vi.waitFor(() => expect(native.refresh).toHaveBeenCalledOnce())
    const playing = engine.play()
    expect(native.play).not.toHaveBeenCalled()
    if (pause) engine.pause()
    finish(); await refresh
    expect(await playing).toBe(!pause)
    expect(native.play).toHaveBeenCalledTimes(pause ? 0 : 1)
  } finally { engine.destroy() }
})
