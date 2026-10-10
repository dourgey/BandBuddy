// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EqWindow } from '../src/renderer/src/components/EqWindow.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'
import { PracticePersistence } from '../src/renderer/src/practice-persistence.js'
import type { MultiTrackAudioEngine } from '../src/renderer/src/audio-engine.js'

const engine = { setEqVisualizationActive: vi.fn(), getEqVisualData: vi.fn(() => null) }
const commit = vi.fn(async () => undefined), close = vi.fn()
function mount(locked = false, persistence = new PracticePersistence(async () => undefined)): ReturnType<typeof render> {
  return render(<EqWindow engine={engine as unknown as MultiTrackAudioEngine} persistence={persistence} locked={locked} onCommit={commit} onClose={close} />)
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.clearAllMocks()
  usePlayerStore.getState().loadSong(fixtureDetail(fixtureSongs[0]!))
})
afterEach(() => { cleanup(); usePlayerStore.getState().unload(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('song EQ window', () => {
  it('edits ten bands, enables EQ on first adjustment, and flushes at gesture completion', () => {
    mount()
    expect(screen.getAllByRole('slider')).toHaveLength(10)
    const slider = screen.getByRole('slider', { name: '125 Hz 增益' })
    fireEvent.change(slider, { target: { value: '4.2' } }); fireEvent.pointerUp(slider)
    expect(usePlayerStore.getState().practice?.eq).toMatchObject({ enabled: true })
    expect(usePlayerStore.getState().practice?.eq.graphicGains[2]).toBe(4.2)
    expect(commit).toHaveBeenCalled()
    fireEvent.wheel(slider, { deltaY: -120 })
    expect(usePlayerStore.getState().practice?.eq.graphicGains[2]).toBe(4.3)
    fireEvent.doubleClick(slider)
    expect(usePlayerStore.getState().practice?.eq.graphicGains[2]).toBe(0)
  })

  it('keeps separate banks through mode switching, bypass and current-mode reset', () => {
    mount()
    fireEvent.change(screen.getByRole('slider', { name: '250 Hz 增益' }), { target: { value: '-5' } })
    fireEvent.click(screen.getByRole('switch', { name: '自由曲线模式' }))
    expect(screen.getAllByRole('button', { name: /^频段/ })).toHaveLength(4)
    fireEvent.change(screen.getByRole('spinbutton', { name: '选中频段增益' }), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('switch', { name: '启用歌曲 EQ' }))
    expect(usePlayerStore.getState().practice?.eq.enabled).toBe(false)
    expect(usePlayerStore.getState().practice?.eq.nodes[0]!.gainDb).toBe(8)
    fireEvent.click(screen.getByRole('button', { name: '重置当前模式' }))
    expect(usePlayerStore.getState().practice?.eq.nodes[0]!.gainDb).toBe(0)
    fireEvent.click(screen.getByRole('switch', { name: '自由曲线模式' }))
    expect(usePlayerStore.getState().practice?.eq.graphicGains[3]).toBe(-5)
  })

  it('changes Q with the wheel and deletes all nodes to a flat bank', () => {
    mount(); fireEvent.click(screen.getByRole('switch', { name: '自由曲线模式' }))
    const first = screen.getAllByRole('button', { name: /^频段/ })[0]!
    fireEvent.wheel(first, { deltaY: -100 })
    expect(usePlayerStore.getState().practice?.eq.nodes[0]!.q).toBe(1.1)
    for (let index = 0; index < 4; index++) {
      fireEvent.focus(screen.getAllByRole('button', { name: /^频段/ })[0]!)
      fireEvent.click(screen.getByRole('button', { name: '删除选中频段' }))
    }
    expect(usePlayerStore.getState().practice?.eq.nodes).toEqual([])
    expect(screen.getByText('0 / 8 频段')).toBeTruthy()
  })

  it('captures Escape before application loop shortcuts and releases the spectrum tap', () => {
    usePlayerStore.getState().patchPractice({ loopStartMs: 1000, loopEndMs: 8000, loopEnabled: true })
    const { unmount } = mount()
    const shortcut = vi.fn(); window.addEventListener('keydown', shortcut)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce(); expect(shortcut).not.toHaveBeenCalled()
    expect(usePlayerStore.getState().practice?.loopEnabled).toBe(true)
    unmount(); expect(engine.setEqVisualizationActive).toHaveBeenLastCalledWith(false)
    window.removeEventListener('keydown', shortcut)
  })

  it('retains editing state when saving fails and exposes retry', async () => {
    const writer = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
    const persistence = new PracticePersistence(writer)
    mount(false, persistence)
    const state = usePlayerStore.getState().practice!
    await act(async () => { persistence.schedule(state); await persistence.flush(state.songId).catch(() => undefined) })
    expect(screen.getByRole('status').textContent).toContain('保存失败')
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    await act(async () => { await persistence.flush(state.songId) })
    expect(screen.getByRole('status').textContent).toContain('已保存到此歌曲')
  })

  it('leaves Escape to an application modal above the modeless EQ', () => {
    mount()
    const modal = document.createElement('section')
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    fireEvent.keyDown(modal, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    modal.remove()
    const overlay = document.createElement('div')
    overlay.className = 'dialog-overlay'; overlay.dataset.dialogOpen = 'true'
    document.body.append(overlay)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    overlay.remove()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('disables EQ editing while recording is locked', () => {
    mount(true)
    expect((screen.getByRole('switch', { name: '自由曲线模式' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.wheel(screen.getByRole('slider', { name: '125 Hz 增益' }), { deltaY: -100 })
    expect(usePlayerStore.getState().practice?.eq.enabled).toBe(false)
  })
})
