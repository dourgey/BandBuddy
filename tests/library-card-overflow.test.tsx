// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LibraryPage } from '../src/renderer/src/pages/LibraryPage.js'
import { fixtureSongs } from '../src/renderer/src/fixtures.js'

afterEach(cleanup)

describe('library card overflow text', () => {
  it('limits the recent section to three roomy cards', () => {
    const onPlay = vi.fn()
    render(<LibraryPage
      songs={fixtureSongs}
      loading={false}
      query=""
      filter="all"
      layout="list"
      onQuery={vi.fn()}
      onFilter={vi.fn()}
      onLayout={vi.fn()}
      onImport={vi.fn()}
      onOpen={vi.fn()}
      onPlay={onPlay}
      onFavorite={vi.fn()}
      onMenu={vi.fn()}
    />)

    expect(screen.getAllByRole('article')).toHaveLength(3)
    const continueButtons = screen.getAllByRole('button', { name: '继续练习' })
    expect(continueButtons).toHaveLength(3)
    fireEvent.click(continueButtons[0]!)
    expect(onPlay).toHaveBeenCalledWith(fixtureSongs[0])
  })

  it('measures long card metadata on hover and enables scrolling only when needed', () => {
    const song = {
      ...fixtureSongs[0]!,
      title: '这是一首标题特别特别长并且需要在卡片内自动滚动展示的歌曲',
      artist: '一位名字同样非常非常长的艺术家与他的乐队',
      status: 'processing' as const,
      phase: '正在执行一个名称很长很长的本地音频分轨处理阶段'
    }
    render(<LibraryPage
      songs={[song]}
      loading={false}
      query=""
      filter="all"
      layout="list"
      onQuery={vi.fn()}
      onFilter={vi.fn()}
      onLayout={vi.fn()}
      onImport={vi.fn()}
      onOpen={vi.fn()}
      onPlay={vi.fn()}
      onFavorite={vi.fn()}
      onMenu={vi.fn()}
    />)

    const title = document.querySelector('.song-card')!.querySelector(`[title="${song.title}"]`) as HTMLElement
    expect(screen.getAllByTitle(song.artist)[0]!.classList.contains('card-scroll-text')).toBe(true)
    expect(screen.getAllByTitle(song.phase)[0]!.classList.contains('card-scroll-text')).toBe(true)
    const content = title.querySelector('span')!
    Object.defineProperty(title, 'clientWidth', { configurable: true, value: 100 })
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 260 })
    fireEvent.mouseEnter(title)

    expect(title.dataset.overflow).toBe('true')
    expect(title.style.getPropertyValue('--card-scroll-distance')).toBe('160px')
    expect(title.style.getPropertyValue('--card-scroll-duration')).toBe('6.60s')

    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 100 })
    fireEvent.mouseEnter(title)
    expect(title.dataset.overflow).toBe('false')
    expect(title.style.getPropertyValue('--card-scroll-distance')).toBe('')
  })
})
