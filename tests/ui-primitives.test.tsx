// @vitest-environment jsdom
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Select } from '../src/renderer/src/components/ui/Select.js'
import { ConfirmHost, confirmAction, promptAction } from '../src/renderer/src/components/ui/confirm.js'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  // jsdom exposes the popover UA stylesheet but does not implement the top-layer API.
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('themed select', () => {
  it('keeps the visible control named and clickable when its label wraps the field', () => {
    render(<label>延迟模式<Select defaultValue="balanced"><option value="balanced">平衡</option><option value="playback">稳定播放</option></Select></label>)
    expect(screen.getByRole('combobox', { name: '延迟模式' })).toBeTruthy()
    fireEvent.click(screen.getByText('延迟模式'))
    expect(screen.getByRole('listbox')).toBeTruthy()
  })
  it('skips disabled options by keyboard and dispatches native change/form values exactly once', () => {
    const change = vi.fn()
    function Form(): React.JSX.Element {
      const [value, setValue] = useState('warm')
      return <form aria-label="外观"><Select name="theme" aria-label="主题" value={value} onChange={event => { change(event.target.value); setValue(event.target.value) }}><option value="warm">暖色</option><option value="unused" disabled>禁用</option><option value="dark">深色</option><option value="system">跟随系统</option></Select></form>
    }
    render(<Form />)
    const trigger = screen.getByRole('combobox', { name: '主题' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(change).toHaveBeenCalledExactlyOnceWith('dark')
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('theme')).toBe('dark')
    expect(trigger.textContent).toContain('深色')
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes only the popup on first Escape, then permits the surrounding modal to close', async () => {
    function Modal(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay /><Dialog.Content aria-describedby={undefined}><Dialog.Title>音频设置</Dialog.Title><Select aria-label="缓冲区" defaultValue="128"><option value="128">128</option><option value="256">256</option></Select></Dialog.Content></Dialog.Portal></Dialog.Root>
    }
    render(<Modal />)
    const trigger = screen.getByRole('combobox', { name: '缓冲区' })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox').closest('[role="dialog"]')).toBe(screen.getByRole('dialog'))
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('retains form reset semantics for uncontrolled fields', async () => {
    render(<form aria-label="参数"><Select name="quality" aria-label="质量" defaultValue="full"><option value="full">完整</option><option value="lite">轻量</option></Select><button type="reset">重置</button></form>)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: '轻量' }))
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('quality')).toBe('lite')
    fireEvent.click(screen.getByRole('button', { name: '重置' }))
    await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('完整'))
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('quality')).toBe('full')
  })
})

describe('asynchronous confirmation dialogs', () => {
  it('queues independent confirmations and resolves cancelling separately from approving', async () => {
    render(<ConfirmHost />)
    let first!: Promise<boolean>, second!: Promise<boolean>
    act(() => { first = confirmAction({ title: '删除第一项', message: '第一项内容', destructive: true, confirmLabel: '删除' }); second = confirmAction({ title: '继续第二项', message: '第二项内容' }) })
    expect(screen.getByRole('dialog', { name: '删除第一项' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(await first).toBe(false)
    expect(screen.getByRole('dialog', { name: '继续第二项' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(await second).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps Chinese IME Enter from submitting until composition has ended', async () => {
    render(<ConfirmHost />)
    let result!: Promise<string | null>
    act(() => { result = promptAction({ title: '重命名', defaultValue: '旧名称', confirmLabel: '保存' }) })
    const input = screen.getByRole('textbox', { name: '重命名' })
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '新录音' } })
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    fireEvent(input, composingEnter)
    const prevented = composingEnter.defaultPrevented
    fireEvent.compositionEnd(input)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await result).toBe('新录音')
    expect(prevented).toBe(true)
  })

  it('treats Escape as cancelled input and disables submitting whitespace-only names', async () => {
    render(<ConfirmHost />)
    let result!: Promise<string | null>
    act(() => { result = promptAction({ title: '新录音名', defaultValue: ' ' }) })
    expect((screen.getByRole('button', { name: '确认' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(await result).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
