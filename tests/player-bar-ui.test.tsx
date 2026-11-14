// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerBar } from '../src/renderer/src/components/PlayerBar.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'

const baseProps = {
  practiceMode: true,
  countInRemaining: 0,
  locked: false,
  onToggle: vi.fn(),
  onSeek: vi.fn(),
  onRestart: vi.fn(),
  onCycleLoop: vi.fn(),
  onPractice: vi.fn()
}

describe('player bar compact controls', () => {
  beforeEach(() => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.practice.playbackRate = 0.8
    usePlayerStore.getState().loadSong(song)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    usePlayerStore.getState().unload()
    vi.clearAllMocks()
  })

  it('stays open after a real click sequence, mouse leave and speed edits until toggled closed', () => {
    vi.useFakeTimers()
    render(<PlayerBar {...baseProps} />)
    const speed = screen.getByRole('button', { name: '播放速度 0.80 倍' })
    expect(speed.textContent).toBe('0.80×')
    expect(screen.queryByRole('dialog', { name: '无级变速滑轨' })).toBeNull()

    fireEvent.mouseEnter(speed.closest('.speed-option')!)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('dialog', { name: '无级变速滑轨' })).toBeNull()
    fireEvent.pointerDown(speed)
    fireEvent.focus(speed)
    fireEvent.click(speed)
    fireEvent.mouseLeave(speed.closest('.speed-option')!)
    fireEvent.blur(speed)
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByRole('slider', { name: '无级播放速度' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1.2×' }))
    expect(usePlayerStore.getState().practice?.playbackRate).toBe(1.2)
    fireEvent.change(screen.getByRole('slider', { name: '无级播放速度' }), { target: { value: '1.13' } })
    expect(usePlayerStore.getState().practice?.playbackRate).toBe(1.13)
    expect(speed.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(speed)
    expect(screen.queryByRole('dialog', { name: '无级变速滑轨' })).toBeNull()
  })

  it('closes speed controls with Escape or an outside click and can reopen', () => {
    render(<PlayerBar {...baseProps} />)
    const speed = screen.getByRole('button', { name: '播放速度 0.80 倍' })
    fireEvent.click(speed)
    fireEvent.keyDown(screen.getByRole('slider', { name: '无级播放速度' }), { key: 'Escape' })
    expect(document.activeElement).toBe(speed)
    expect(speed.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(speed)
    fireEvent.pointerDown(document.body)
    expect(speed.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps only the master-volume icon visible and toggles mute without losing the level', () => {
    render(<PlayerBar {...baseProps} />)
    expect(screen.queryByRole('button', { name: /主音量增益/ })).toBeNull()
    expect(screen.getByRole('slider', { name: '总音量' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '总音量：静音' }))
    expect(usePlayerStore.getState().practice?.masterGainDb).toBe(-60)
    fireEvent.click(screen.getByRole('button', { name: '总音量：取消静音' }))
    expect(usePlayerStore.getState().practice?.masterGainDb).toBe(0)
  })

  it('opens the playable-song list and switches directly to a ready song', () => {
    const onSelectSong = vi.fn()
    render(<PlayerBar {...baseProps} songs={fixtureSongs} onSelectSong={onSelectSong} />)
    fireEvent.click(screen.getByRole('button', { name: '练习歌曲列表' }))
    expect(screen.getByRole('dialog', { name: '可练习列表' })).toBeTruthy()
    expect((screen.getByRole('button', { name: /夜空中最亮的星/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Hotel California/ }))
    expect(onSelectSong).toHaveBeenCalledWith(fixtureSongs[1]!.id)
    expect(screen.queryByRole('dialog', { name: '可练习列表' })).toBeNull()
  })
})
