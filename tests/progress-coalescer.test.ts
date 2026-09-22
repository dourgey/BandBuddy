import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProgressCoalescer } from '../src/main/progress-coalescer.js'

afterEach(() => vi.useRealTimers())

describe('job progress publication', () => {
  it('coalesces a burst and publishes the most recent progress', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const progress = new ProgressCoalescer<number>(publish)
    progress.push(0, 'separating')
    for (let value = 1; value <= 100; value += 1) progress.push(value, 'separating')
    expect(publish).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(publish.mock.calls).toEqual([[0], [100]])
  })

  it('publishes new phases immediately and never overwrites a final state', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const progress = new ProgressCoalescer<number>(publish)
    progress.push(1, 'preparing')
    progress.push(2, 'preparing')
    progress.push(3, 'separating')
    progress.push(4, 'separating')
    progress.cancel()
    vi.runAllTimers()
    expect(publish.mock.calls).toEqual([[1], [3]])
  })
})
