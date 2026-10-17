// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiApi, type AiConversation, type AiEvent, type AiMessage } from '../packages/shared/src/ai.js'
import type { BandBuddyApi } from '../packages/shared/src/bridge.js'
import AiChat, { mergeAiMessages } from '../src/renderer/src/ai/AiChat.js'
import { AiSettingsDialog } from '../src/renderer/src/ai/AiSettingsDialog.js'
import { LaboratoryDialog } from '../src/renderer/src/ai/LaboratoryDialog.js'

const id = '12345678-1234-4123-8123-123456789012'
const secondId = '12345678-1234-4123-8123-123456789013'
const settings = { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.com/v1', model: 'vision-model' }
const conversation = (key = id): AiConversation => ({ id: key, title: '新对话', preview: '', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', revision: 0, messages: [] })
const message = (patch: Partial<AiMessage> = {}): AiMessage => ({ id: 'reply', conversationId: id, role: 'assistant', text: '回复', images: [], status: 'complete', error: null, model: 'vision-model', createdAt: '2026-10-13T00:00:00Z', revision: 1, finishReason: 'stop', ...patch })
let api: AiApi
let emit: (event: AiEvent) => void
beforeEach(() => {
  localStorage.clear()
  emit = () => {}
  api = {
    getSettings: vi.fn(async () => ({ settings, hasToken: true, verified: true })),
    saveSettings: vi.fn(async input => ({ settings: input.settings, hasToken: input.token !== null, verified: false })),
    testSettings: vi.fn(async () => ({ model: 'test-model', elapsedMs: 150 })),
    list: vi.fn(async () => []), get: vi.fn(async key => conversation(key)), create: vi.fn(async () => conversation()),
    rename: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    send: vi.fn(async input => ({ ...conversation(input.conversationId), revision: 2, messages: [message({ id: 'user', role: 'user', text: input.text }), message({ text: '', status: 'streaming' })] })),
    retry: vi.fn(async () => conversation()), cancel: vi.fn(async () => {}),
    onChanged: callback => { emit = callback; return () => {} }
  }
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { ai: api } as BandBuddyApi })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function chat() {
  render(<AiChat open onOpenChange={() => {}} />)
  await waitFor(() => expect(screen.queryByText('正在读取对话…')).toBeNull())
  return screen.getByRole('textbox', { name: '消息内容' })
}

describe('AI chat interactions', () => {
  it('renders saved Markdown replies while preserving user input and copied source text', async () => {
    const markdown = '# 练习计划\n\n**先热身**，再用 `A–B` 循环，*慢慢加速*。\n\n1. 导入歌曲\n2. 开始练习\n\n- 节拍器\n  - 每分钟 80 拍\n\n> 注意节奏\n\n| 项目 | 状态 |\n| --- | --- |\n| 吉他 | 就绪 |\n\n- [x] 热身\n- [ ] 合奏\n\n~~跳过练习~~\n\n```js\nconst bpm = 80\n```'
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    try {
      const saved = { ...conversation(), messages: [message({ id: 'question', role: 'user', text: '**我的原始输入**' }), message({ text: markdown })] }
      vi.mocked(api.list).mockResolvedValue([saved])
      vi.mocked(api.get).mockResolvedValue(saved)
      await chat()
      const reply = await screen.findByRole('article', { name: 'AI 回复' })
      expect(within(reply).getByRole('heading', { name: '练习计划', level: 1 })).toBeTruthy()
      expect(reply.querySelector('strong')?.textContent).toBe('先热身')
      expect(reply.querySelector('em')?.textContent).toBe('慢慢加速')
      expect(reply.querySelector('ol > li')?.textContent).toBe('导入歌曲')
      expect(reply.querySelector('ul ul li')?.textContent).toBe('每分钟 80 拍')
      expect(reply.querySelector('blockquote')?.textContent).toContain('注意节奏')
      expect(within(reply).getByRole('table').textContent).toContain('吉他就绪')
      const tasks = within(reply).getAllByRole('checkbox') as HTMLInputElement[]
      expect(tasks.map(item => [item.checked, item.disabled])).toEqual([[true, true], [false, true]])
      expect(reply.querySelector('del')?.textContent).toBe('跳过练习')
      expect(reply.querySelector('pre code')?.textContent).toBe('const bpm = 80\n')
      const user = screen.getByRole('article', { name: '我的消息' })
      expect(user.textContent).toContain('**我的原始输入**')
      expect(user.querySelector('strong')).toBeNull()
      fireEvent.click(within(reply).getByRole('button', { name: '复制消息' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
    } finally { vi.unstubAllGlobals() }
  })
  it('renders incremental Markdown including an unfinished code fence, then completes it without losing content', async () => {
    const saved = { ...conversation(), messages: [message({ text: '## 节奏\n\n```js\nconst', status: 'streaming' })] }
    vi.mocked(api.list).mockResolvedValue([saved])
    vi.mocked(api.get).mockResolvedValue(saved)
    await chat()
    const reply = await screen.findByRole('article', { name: 'AI 回复' })
    expect(within(reply).getByRole('heading', { name: '节奏', level: 2 })).toBeTruthy()
    expect(reply.querySelector('pre code')?.textContent).toBe('const\n')
    act(() => emit({ type: 'message', message: message({ text: '## 节奏\n\n```js\nconst bpm = 80\n```\n\n**完成啦**', revision: 2 }) }))
    expect(await within(reply).findByText('完成啦')).toBeTruthy()
    expect(reply.querySelector('pre code')?.textContent).toBe('const bpm = 80\n')
    expect(within(reply).queryByText('正在回复…')).toBeNull()
  })
  it('does not execute raw HTML, load remote Markdown images, or create unsafe navigation links', async () => {
    const saved = { ...conversation(), messages: [message({ text: '<script>alert(1)</script>\n\n<img src="https://example.com/track.png" onerror="alert(1)">\n\n![谱例](https://example.com/score.png)\n\n[危险](javascript:alert%281%29)\n\n[指南](https://example.com/guide)' })] }
    vi.mocked(api.list).mockResolvedValue([saved])
    vi.mocked(api.get).mockResolvedValue(saved)
    await chat()
    const reply = await screen.findByRole('article', { name: 'AI 回复' })
    expect(reply.querySelector('script, img, iframe, a')).toBeNull()
    expect(reply.innerHTML).not.toContain('onerror')
    expect(reply.textContent).not.toContain('javascript:')
    expect(reply.textContent).toContain('[图片：谱例]')
    expect(reply.textContent).toContain('指南 (https://example.com/guide)')
  })
  it('labels the assistant as Bangbang and hides historical model metadata', async () => {
    const saved = { ...conversation(), messages: [message({ model: 'provider/private-model' })] }
    vi.mocked(api.list).mockResolvedValue([saved])
    vi.mocked(api.get).mockResolvedValue(saved)
    await chat()
    expect(await screen.findByText('邦邦')).toBeTruthy()
    expect(screen.getByText(/邦邦 · 陪你聊音乐/)).toBeTruthy()
    expect(screen.queryByText('provider/private-model')).toBeNull()
  })
  it('allows chatting with empty user settings and keeps the settings form empty', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ settings: DEFAULT_AI_SETTINGS, hasToken: false, verified: false })
    const input = await chat()
    fireEvent.change(input, { target: { value: '你好' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    expect(api.create).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'AI 设置' }))
    fireEvent.click(await screen.findByRole('button', { name: 'AI 对话设置' }))
    expect(await screen.findByRole('dialog', { name: 'AI 对话设置' })).toBeTruthy()
    await waitFor(() => expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe(''))
    expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Token / API Key') as HTMLInputElement).value).toBe('')
  })
  it('preserves the first message draft when creating a conversation succeeds but sending fails', async () => {
    vi.mocked(api.list).mockImplementation(async () => vi.mocked(api.create).mock.calls.length ? [conversation()] : [])
    vi.mocked(api.send).mockRejectedValue(new Error('请求参数有误'))
    const input = await chat()
    fireEvent.change(input, { target: { value: '保留我的提问' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    await waitFor(() => expect((screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('保留我的提问'))
    expect(await screen.findByText('请求参数有误')).toBeTruthy()
  })
  it('respects IME composition and Shift+Enter, and sends one message on a regular Enter', async () => {
    vi.mocked(api.list).mockResolvedValue([conversation()])
    const input = await chat()
    fireEvent.change(input, { target: { value: '中文输入' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce())
    expect(api.send).toHaveBeenCalledWith({ conversationId: id, text: '中文输入', images: [] })
    expect(await screen.findByRole('button', { name: '停止生成' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(api.cancel).toHaveBeenCalledWith(id)
  })
  it('keeps streamed replies attached to their conversation when the user switches history', async () => {
    const first = { ...conversation(), title: '第一段', revision: 2, messages: [message({ text: '', status: 'streaming', revision: 0 })] }
    const second = { ...conversation(secondId), title: '第二段' }
    vi.mocked(api.list).mockResolvedValue([first, second])
    vi.mocked(api.get).mockImplementation(async key => key === id ? first : second)
    await chat()
    fireEvent.click(screen.getByRole('button', { name: /第二段/ }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(secondId))
    act(() => emit({ type: 'message', message: message({ text: '只属于第一段的回复', revision: 3 }) }))
    expect(screen.queryByText('只属于第一段的回复')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /第一段/ }))
    expect(await screen.findByText('只属于第一段的回复')).toBeTruthy()
  })
  it('does not let stale snapshots erase messages, roll back a stream, or resurrect a replaced retry', () => {
    const newer = { ...conversation(), revision: 2, messages: [message({ text: '已完成', revision: 5 })] }
    expect(mergeAiMessages(conversation(), newer, new Map()).messages).toEqual(newer.messages)
    const update = message({ text: '最新片段', revision: 6 })
    expect(mergeAiMessages(newer, undefined, new Map([[update.id, update]])).messages[0]?.text).toBe('最新片段')
    const retry = { ...newer, revision: 3, messages: [message({ id: 'retry', revision: 0, status: 'streaming', text: '' })] }
    expect(mergeAiMessages(retry, newer, new Map([[update.id, update]])).messages.map(item => item.id)).toEqual(['retry'])
  })
  it('keeps chat keys from triggering the background music shortcuts', async () => {
    const input = await chat(), shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)
    try {
      fireEvent.keyDown(input, { key: ' ', code: 'Space' })
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'AI 对话', exact: true }), { key: 's', ctrlKey: true })
      expect(shortcut).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', shortcut) }
  })
})

describe('AI settings form', () => {
  it('reports a failed check without claiming activation or displaying service defaults', async () => {
    vi.mocked(api.testSettings).mockRejectedValue(new Error('AI 接口返回 401：Token 无效或已过期'))
    render(<AiSettingsDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('vision-model'))
    fireEvent.change(screen.getByLabelText('Token / API Key'), { target: { value: 'invalid-test-token' } })
    fireEvent.click(screen.getByRole('button', { name: '检验配置' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('401')
    expect(screen.queryByText(/配置已保存并启用/)).toBeNull()
    expect(api.saveSettings).not.toHaveBeenCalled()
  })
  it('checks the edited form, retains its encrypted token and refreshes the enabled configuration', async () => {
    render(<AiSettingsDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe(settings.baseUrl))
    const token = screen.getByLabelText('Token / API Key') as HTMLInputElement
    expect(token.type).toBe('password'); expect(token.value).toBe('')
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'unsaved-model' } })
    vi.mocked(api.getSettings).mockResolvedValue({ settings: { ...settings, model: 'unsaved-model' }, hasToken: true, verified: true })
    fireEvent.click(screen.getByRole('button', { name: '检验配置' }))
    await waitFor(() => expect(api.testSettings).toHaveBeenCalledOnce())
    expect(api.testSettings).toHaveBeenCalledWith({ settings: { ...settings, model: 'unsaved-model' } })
    expect(api.saveSettings).not.toHaveBeenCalled()
    await screen.findByText(/检验通过，配置已保存并启用/)
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ settings: { ...settings, model: 'unsaved-model' } }))
  })
  it('shows only connection settings, resets legacy options and clears credentials through an explicit saved change', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ settings: { ...settings, contextTurns: 100, temperature: 1.5, stream: false, extraBody: '{"enable_thinking":true}' }, hasToken: true, verified: true })
    render(<AiSettingsDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('vision-model'))
    expect(document.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(3)
    expect(screen.queryByLabelText('上下文轮数')).toBeNull()
    expect(screen.queryByLabelText('额外请求参数（JSON）')).toBeNull()
    fireEvent.click(screen.getByLabelText('清除已保存的 Token'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ settings, token: null }))
  })
  it('places AI settings inside the laboratory and returns to the laboratory on close', async () => {
    render(<LaboratoryDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('dialog', { name: '实验室功能', exact: true })).toBeTruthy()
    expect(screen.queryByLabelText('Base URL')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'AI 对话设置' }))
    expect(await screen.findByLabelText('Base URL')).toBeTruthy()
    await waitFor(() => expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('vision-model'))
    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 设置' }))
    expect(screen.getByRole('dialog', { name: '实验室功能', exact: true })).toBeTruthy()
    expect(screen.queryByLabelText('Base URL')).toBeNull()
  })
})
