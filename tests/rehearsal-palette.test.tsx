// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RehearsalRoom } from '../src/renderer/src/pages/RehearsalRoom.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import type { SongSummary } from '../packages/shared/src/domain.js'

vi.mock('../src/renderer/src/rehearsal-audio-engine.js', () => ({
  RehearsalAudioEngine: class {
    onTime = vi.fn()
    onEnded = vi.fn()
    onError = vi.fn()
    configure = vi.fn(async () => {})
    play = vi.fn(async () => true)
    pause = vi.fn()
    stop = vi.fn(async () => {})
    destroy = vi.fn()
    setVisualActive = vi.fn()
    isPlaying = false
    positionMs = 0
  }
}))

const previousWidth = window.innerWidth
let summaries: SongSummary[]
const props = { onActiveChange: vi.fn(), onOpenSongSettings: vi.fn(), onRecordingLockChange: vi.fn(), onToast: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 })
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  summaries = Array.from({ length: 10000 }, (_, index) => index < 3 ? { ...fixtureSongs[index]! } : {
    ...fixtureSongs[0]!,
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: index === 9999 ? '中文末尾歌曲' : `素材 ${String(index).padStart(5, '0')}`,
    artist: '测试乐队'
  })
  const byId = new Map(summaries.map((song) => [song.id, song]))
  vi.spyOn(window.bandbuddy.library, 'list').mockResolvedValue(summaries)
  vi.spyOn(window.bandbuddy.library, 'get').mockImplementation(async (id) => {
    const song = byId.get(id)
    return song ? fixtureDetail(song) : null
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
})

async function openPalette() {
  const rendered = render(<RehearsalRoom {...props} />)
  await screen.findByText('排练队列')
  await screen.findByText('10000 首可用')
  const palette = rendered.container.querySelector<HTMLElement>('.rehearsal-song-assets')!
  expect(palette).toBeTruthy()
  return { ...rendered, palette }
}

describe('large rehearsal material palette', () => {
  it('bounds the mounted rows for ten thousand songs and removes all rows while collapsed', async () => {
    const { container } = await openPalette()
    const countRows = () => container.querySelectorAll('.rehearsal-song-asset').length
    expect(countRows()).toBeGreaterThan(0)
    expect(countRows()).toBeLessThanOrEqual(20)
    expect(window.bandbuddy.library.list).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '收起曲库素材' }))
    expect(countRows()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '展开曲库素材' }))
    expect(countRows()).toBeGreaterThan(0)
    expect(countRows()).toBeLessThanOrEqual(20)
    expect(window.bandbuddy.library.list).toHaveBeenCalledOnce()
  })

  it('can append a song around row one thousand after scrolling without mounting the preceding rows', async () => {
    const { container, palette } = await openPalette()
    expect(within(palette).queryByRole('button', { name: '将 素材 01000 加入队列' })).toBeNull()
    fireEvent.scroll(palette, { target: { scrollTop: 1000 * 56 } })
    const addSong = within(palette).getByRole('button', { name: '将 素材 01000 加入队列' })
    expect(palette.querySelectorAll('.rehearsal-song-asset').length).toBeLessThanOrEqual(20)
    expect(within(palette).queryByRole('button', { name: `将 ${fixtureSongs[0]!.title} 加入队列` })).toBeNull()
    fireEvent.click(addSong)
    await waitFor(() => {
      const items = container.querySelectorAll('.rehearsal-queue-item')
      expect(items).toHaveLength(4)
      expect(items[3]!.textContent).toContain('素材 01000')
    })
    await waitFor(() => expect(window.bandbuddy.library.get).toHaveBeenCalledWith(summaries[1000]!.id))
    expect(palette.querySelectorAll('.rehearsal-song-asset').length).toBeLessThanOrEqual(20)
  })

  it('waits for Chinese composition to finish and the debounce to elapse, then finds a tail song and clears immediately', async () => {
    const { palette } = await openPalette()
    const input = screen.getByRole('textbox', { name: '搜索排练素材' }) as HTMLInputElement
    vi.useFakeTimers()
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'zhong' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(input.value).toBe('zhong')
    expect(within(palette).getByRole('button', { name: `将 ${fixtureSongs[0]!.title} 加入队列` })).toBeTruthy()
    expect(screen.queryByText('没有匹配的已就绪歌曲')).toBeNull()

    fireEvent.change(input, { target: { value: '中文末尾歌曲' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(within(palette).queryByRole('button', { name: '将 中文末尾歌曲 加入队列' })).toBeNull()
    fireEvent.compositionEnd(input, { data: '中文末尾歌曲' })
    await act(async () => { await vi.advanceTimersByTimeAsync(149) })
    expect(within(palette).queryByRole('button', { name: '将 中文末尾歌曲 加入队列' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(within(palette).getByRole('button', { name: '将 中文末尾歌曲 加入队列' })).toBeTruthy()
    expect(palette.querySelectorAll('.rehearsal-song-asset')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(input.value).toBe('')
    expect(within(palette).getByRole('button', { name: `将 ${fixtureSongs[0]!.title} 加入队列` })).toBeTruthy()
    expect(palette.querySelectorAll('.rehearsal-song-asset').length).toBeLessThanOrEqual(20)
    expect(window.bandbuddy.library.list).toHaveBeenCalledOnce()
  })
})
