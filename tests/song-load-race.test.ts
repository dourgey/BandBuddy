import { afterEach, describe, expect, it, vi } from 'vitest'
import { MultiTrackAudioEngine } from '../src/renderer/src/audio-engine.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
afterEach(() => vi.unstubAllGlobals())
describe('song load generation', () => {
  it('does not recreate old tracks after a newer song has loaded', async () => {
    const delayed = deferred()
    const elements: Array<{ src: string }> = []
    vi.stubGlobal('Audio', class { src = ''; constructor() { elements.push(this) } })
    vi.stubGlobal('navigator', { platform: 'Win32' })
    const node = () => ({ connect() { return this }, disconnect() {} })
    const context = { setSinkId: vi.fn(async () => {}), createMediaElementSource: node, createGain: node, createChannelSplitter: node }
    const engine = new MultiTrackAudioEngine()
    Object.assign(engine, { context, pause: vi.fn(), destroyTracks: vi.fn(), configureOutputGraph: vi.fn(), applyPractice: vi.fn(), ensureContext: vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(undefined) })
    const oldSong = fixtureDetail(fixtureSongs[0]!)
    const newSong = fixtureDetail(fixtureSongs[1]!)
    const older = engine.load(oldSong)
    await engine.load(newSong)
    const loadedCount = elements.length
    expect(loadedCount).toBeGreaterThan(0)
    delayed.resolve()
    await older
    expect(elements).toHaveLength(loadedCount)
    expect(elements.some((element) => element.src === newSong.stems[0]?.mediaUrl)).toBe(true)
  })
  it('does not create media after unloading while context initialization is pending', async () => {
    const delayed = deferred()
    const audio = vi.fn()
    vi.stubGlobal('Audio', audio)
    const engine = new MultiTrackAudioEngine()
    Object.assign(engine, { pause: vi.fn(), destroyTracks: vi.fn(), ensureContext: () => delayed.promise })
    const loading = engine.load(fixtureDetail(fixtureSongs[0]!))
    engine.unload()
    delayed.resolve()
    await loading
    expect(audio).not.toHaveBeenCalled()
  })
})
