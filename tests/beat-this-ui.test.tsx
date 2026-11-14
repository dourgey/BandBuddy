// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerBar } from '../src/renderer/src/components/PlayerBar.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'

describe('Beat This detection controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
    installFixtureBridge()
    usePlayerStore.getState().loadSong(fixtureDetail(fixtureSongs[0]!))
  })
  afterEach(() => { cleanup(); usePlayerStore.getState().unload(); vi.restoreAllMocks() })
  const props = { practiceMode: true, countInRemaining: 0, locked: false, onToggle: vi.fn(), onSeek: vi.fn(), onRestart: vi.fn(), onCycleLoop: vi.fn(), onPractice: vi.fn() }

  it('shows the model and applies predicted BPM and phase', async () => {
    vi.spyOn(window.bandbuddy.media, 'detectBpm').mockResolvedValue({ bpm: 123.4, beatOffsetMs: 137, confidence: 0.95, analyzedStem: 'mix', model: 'beat-this-final0' })
    render(<PlayerBar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '节拍器' }))
    expect(screen.getByText('Beat This · 分析整曲，结果自动保存')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /检测当前歌曲 BPM/ })) })
    expect(screen.getByText(/检测到 123.4 BPM · Beat This · 整曲/)).toBeTruthy()
    expect(usePlayerStore.getState().practice).toMatchObject({ metronomeBpm: 123.4, metronomeOffsetMs: 137 })
  })

  it('does not apply an earlier song result after switching songs during inference', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof window.bandbuddy.media.detectBpm>>) => void
    vi.spyOn(window.bandbuddy.media, 'detectBpm').mockImplementation(() => new Promise(done => { resolve = done }))
    render(<PlayerBar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '节拍器' }))
    fireEvent.click(screen.getByRole('button', { name: /检测当前歌曲 BPM/ }))
    const next = fixtureDetail(fixtureSongs[1]!)
    act(() => usePlayerStore.getState().loadSong(next))
    const before = usePlayerStore.getState().practice!.metronomeBpm
    await act(async () => { resolve({ bpm: 200, beatOffsetMs: 100, confidence: 1, analyzedStem: 'mix', model: 'beat-this-final0' }) })
    expect(usePlayerStore.getState().practice!.metronomeBpm).toBe(before)
  })
})
