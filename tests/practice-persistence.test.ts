import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPracticeState, type PracticeState } from '../packages/shared/src/domain.js'
import { PracticePersistence } from '../src/renderer/src/practice-persistence.js'

afterEach(() => vi.useRealTimers())
describe('practice persistence queue', () => {
  it('debounces the latest snapshot and captures the song before a fast switch', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async (_state: PracticeState) => undefined), queue = new PracticePersistence(write)
    const songA = createDefaultPracticeState('A'), songB = createDefaultPracticeState('B')
    queue.schedule(songA); songA.eq.graphicGains[0] = 8; queue.schedule(songA)
    queue.schedule(songB)
    await queue.flush('A')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toMatchObject({ songId: 'A', eq: { graphicGains: [8, 0, 0, 0, 0, 0, 0, 0, 0, 0] } })
    expect(queue.getStatus('A')).toBe('saved')
    await vi.advanceTimersByTimeAsync(500)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]![0]).toMatchObject({ songId: 'B' })
  })

  it('serializes writes and never marks an obsolete in-flight revision saved', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const first = new Promise<void>(resolve => { finish = resolve })
    const writes: number[] = []
    const queue = new PracticePersistence(async state => { writes.push(state.eq.graphicGains[0]!); if (writes.length === 1) await first })
    const song = createDefaultPracticeState('A')
    queue.schedule(song); const flush1 = queue.flush('A')
    await Promise.resolve(); await Promise.resolve()
    song.eq.graphicGains[0] = 5; queue.schedule(song)
    const flush2 = queue.flush('A')
    expect(writes).toEqual([0])
    finish(); await flush1
    expect(queue.getStatus('A')).toBe('saving')
    await flush2
    expect(writes).toEqual([0, 5]); expect(queue.getStatus('A')).toBe('saved')
  })

  it('keeps a failed snapshot for retry and continues saving other songs', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(undefined)
    const queue = new PracticePersistence(write)
    const song = createDefaultPracticeState('A'); song.eq.graphicGains[0] = -3
    queue.schedule(song)
    await expect(queue.flush('A')).rejects.toThrow('disk unavailable')
    expect(queue.getStatus('A')).toBe('error')
    queue.schedule(createDefaultPracticeState('B')); await queue.flush('B')
    await queue.flush('A')
    expect(queue.getStatus('A')).toBe('saved')
    expect(write.mock.calls.at(-1)![0].eq.graphicGains[0]).toBe(-3)
  })
})
