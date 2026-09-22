// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LibraryPage } from '../src/renderer/src/pages/LibraryPage.js'
import { fixtureSongs } from '../src/renderer/src/fixtures.js'

const callbacks = () => ({ onQuery: vi.fn(), onFilter: vi.fn(), onLayout: vi.fn(), onImport: vi.fn(), onOpen: vi.fn(), onPlay: vi.fn(), onFavorite: vi.fn(), onMenu: vi.fn(), onPage: vi.fn(), onRecentPage: vi.fn() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.removeItem('bandbuddy.library.recentExpanded') })
describe('library paging and input', () => {
  it('waits for Chinese composition to finish and debounces the completed query', () => {
    vi.useFakeTimers()
    const handlers = callbacks()
    render(<LibraryPage songs={fixtureSongs} loading={false} query="" filter="all" layout="list" {...handlers} />)
    const input = screen.getByRole('textbox', { name: '搜索歌曲或艺术家' })
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'zhong' } })
    act(() => { vi.advanceTimersByTime(500) })
    expect(handlers.onQuery).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '中国' } })
    fireEvent.compositionEnd(input)
    act(() => { vi.advanceTimersByTime(149) })
    expect(handlers.onQuery).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(handlers.onQuery).toHaveBeenCalledExactlyOnceWith('中国')
  })
  it('keeps recent practice independent of an empty search and pages both sections', () => {
    const handlers = callbacks()
    render(<LibraryPage songs={[]} recentSongs={fixtureSongs.slice(0, 3)} recentTotal={7} recentOffset={3} total={100} offset={50} pageSize={50} loading={false} query="找不到" filter="all" layout="list" {...handlers} />)
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.getByText('没有找到匹配的歌曲，试试其他关键词或筛选条件。')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(handlers.onPage).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByRole('button', { name: '下一组' }))
    expect(handlers.onRecentPage).toHaveBeenCalledWith(6)
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('collapses recent practice on short viewports while retaining an explicit expansion across resizes', () => {
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(500)
    render(<LibraryPage songs={fixtureSongs} loading={false} query="" filter="all" layout="list" {...callbacks()} />)
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '展开最近练习' }))
    expect(screen.getAllByRole('article')).toHaveLength(3)
    height.mockReturnValue(900)
    fireEvent(window, new Event('resize'))
    height.mockReturnValue(500)
    fireEvent(window, new Event('resize'))
    expect(screen.getByRole('button', { name: '收起最近练习' }).getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('bandbuddy.library.recentExpanded')).toBe('true')
  })
  it('bounds mounted rows to the scroll viewport, then keeps every row available during keyboard traversal', () => {
    vi.useFakeTimers()
    const songs = Array.from({ length: 50 }, (_, index) => ({ ...fixtureSongs[0]!, id: `song-${index}`, title: `曲目 ${index}` }))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>('.library-page')
      const top = this.classList.contains('song-table') ? 100 - (scroller?.scrollTop ?? 0) : 0
      const height = this.classList.contains('song-row') ? 56 : this.classList.contains('song-table-head') ? 37 : 500
      return { top, bottom: top + height, left: 0, right: 1000, width: 1000, height, x: 0, y: top, toJSON() {} }
    })
    render(<LibraryPage songs={songs} recentSongs={[]} total={5000} loading={false} query="" filter="all" layout="list" {...callbacks()} />)
    expect(screen.getAllByRole('row').length).toBeLessThan(22)
    const scroller = screen.getByRole('main')
    scroller.scrollTop = 1600
    fireEvent.scroll(scroller)
    act(() => vi.advanceTimersByTime(20))
    expect(screen.queryByText('曲目 0')).toBeNull()
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe('5001')
    const play = screen.getAllByRole('button', { name: /^播放 曲目/ })[0]!
    act(() => play.focus())
    expect(screen.getAllByRole('row')).toHaveLength(51)
    act(() => screen.getByRole('textbox').focus())
    expect(screen.getAllByRole('row').length).toBeLessThan(24)
  })
})
