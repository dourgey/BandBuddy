// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RehearsalRoom } from '../src/renderer/src/pages/RehearsalRoom.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

class FakeGainNode {
  gain = {
    value: 1,
    cancelScheduledValues: () => undefined,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined
  }
  connect(): this { return this }
  disconnect(): void {}
}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createGain(): FakeGainNode { return new FakeGainNode() }
  close(): Promise<void> { return Promise.resolve() }
  resume(): Promise<void> { return Promise.resolve() }
}

describe('RehearsalRoom', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext })
    Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
    installFixtureBridge()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds material, supports keyboard ordering, flushes autosave and contains no waveform UI', async () => {
    const onOpenSongSettings = vi.fn()
    const { container, unmount } = render(<RehearsalRoom
      settings={undefined}
      onActiveChange={() => undefined}
      onOpenSongSettings={onOpenSongSettings}
      onRecordingLockChange={() => undefined}
      onToast={() => undefined}
    />)

    await screen.findByText('排练队列')
    expect(container.querySelectorAll('.rehearsal-queue-item')).toHaveLength(3)
    expect(container.querySelector('.waveform')).toBeNull()
    expect(container.querySelector('[class*="stem"]')).toBeNull()

    const addSong = screen.getAllByRole('button', { name: /^将 .* 加入队列$/ })[0]
    expect(addSong).toBeTruthy()
    fireEvent.click(addSong!)
    await waitFor(() => expect(container.querySelectorAll('.rehearsal-queue-item')).toHaveLength(4))

    const firstGrip = screen.getAllByRole('button', { name: /拖动第 1 项/ })[0]
    fireEvent.keyDown(firstGrip!, { key: 'ArrowDown' })
    await waitFor(() => {
      const rows = [...container.querySelectorAll<HTMLElement>('.rehearsal-queue-item')]
      expect(rows[0]?.classList.contains('transition')).toBe(true)
    })

    const settingsButton = screen.getAllByRole('button', { name: '设置' })[0]
    fireEvent.click(settingsButton!)
    await waitFor(() => expect(onOpenSongSettings).toHaveBeenCalledTimes(1))
    expect(onOpenSongSettings.mock.calls[0]?.[0]).toMatchObject({
      rehearsalId: expect.any(String),
      itemId: expect.any(String),
      songId: expect.any(String)
    })

    await waitFor(() => expect(screen.getByText('已自动保存')).toBeTruthy())
    unmount()
  })
})
