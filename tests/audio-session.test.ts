// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimAudioSession,
  getAudioSession,
  isAudioSessionCurrent,
  pauseAudioSession,
  releaseAudioSession,
  useAudioSession
} from '../src/renderer/src/audio-session.js'

const resetSession = () => {
  const current = getAudioSession()
  if (current) releaseAudioSession(current.owner)
}
beforeEach(resetSession)
afterEach(() => {
  cleanup()
  resetSession()
})

describe('audio session ownership', () => {
  it('pauses the previous owner only when another owner explicitly claims playback', () => {
    const pausePractice = vi.fn()
    const pauseWoodshed = vi.fn()
    const first = claimAudioSession('practice', '歌曲练习', pausePractice)
    const { result, rerender } = renderHook(useAudioSession)
    rerender()
    expect(getAudioSession()?.id).toBe(first)
    expect(result.current?.label).toBe('歌曲练习')
    expect(pausePractice).not.toHaveBeenCalled()

    act(() => { claimAudioSession('woodshed', '音阶示范', pauseWoodshed) })
    expect(pausePractice).toHaveBeenCalledOnce()
    expect(pauseWoodshed).not.toHaveBeenCalled()
    expect(result.current?.owner).toBe('woodshed')
    expect(isAudioSessionCurrent(first)).toBe(false)
  })

  it('refreshes one owner without pausing it, and ignores an outdated release token', () => {
    const pause = vi.fn()
    const first = claimAudioSession('woodshed', '旧练习', pause)
    const second = claimAudioSession('woodshed', '当前练习', pause)
    expect(second).not.toBe(first)
    expect(pause).not.toHaveBeenCalled()
    releaseAudioSession('woodshed', first)
    releaseAudioSession('practice')
    expect(getAudioSession()).toMatchObject({ id: second, label: '当前练习' })
    expect(isAudioSessionCurrent(second)).toBe(true)
    releaseAudioSession('woodshed', second)
    expect(getAudioSession()).toBeNull()
  })

  it('allows the paused owner to release itself during an ownership transfer', () => {
    let first = 0
    const pause = vi.fn(() => releaseAudioSession('practice', first))
    first = claimAudioSession('practice', '歌曲', pause)
    const next = claimAudioSession('rehearsal', '排练', vi.fn())
    expect(pause).toHaveBeenCalledOnce()
    expect(getAudioSession()).toMatchObject({ id: next, owner: 'rehearsal' })
  })

  it('supports a pause callback releasing its own session and notifies the UI', () => {
    let id = 0
    const pause = vi.fn(() => releaseAudioSession('practice', id))
    id = claimAudioSession('practice', '歌曲', pause)
    const { result } = renderHook(useAudioSession)
    act(pauseAudioSession)
    expect(pause).toHaveBeenCalledOnce()
    expect(result.current).toBeNull()
    act(pauseAudioSession)
    expect(pause).toHaveBeenCalledOnce()
  })

  it('does not erase a newer session created by a pause callback', () => {
    const nextPause = vi.fn()
    const pause = vi.fn(() => { claimAudioSession('woodshed', '新练习', nextPause) })
    claimAudioSession('woodshed', '旧练习', pause)
    pauseAudioSession()
    expect(pause).toHaveBeenCalledOnce()
    expect(nextPause).not.toHaveBeenCalled()
    expect(getAudioSession()).toMatchObject({ owner: 'woodshed', label: '新练习' })
  })

  it('does not invoke the same callback twice when pause is reentered', () => {
    let entered = false
    const pause = vi.fn(() => {
      if (!entered) {
        entered = true
        pauseAudioSession()
      }
    })
    claimAudioSession('rehearsal', '排练', pause)
    pauseAudioSession()
    expect(pause).toHaveBeenCalledOnce()
    expect(getAudioSession()).toBeNull()
  })
})
