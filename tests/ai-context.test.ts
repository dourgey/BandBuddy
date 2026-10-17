import { describe, expect, it, vi } from 'vitest'
import { AI_CONTEXT_LENGTH, DEFAULT_AI_SETTINGS, type AiMessage } from '../packages/shared/src/ai.js'
import { aiSettingsInputSchema } from '../packages/shared/src/ai-schema.js'
import { compactAiContext, AI_SUMMARY_PROMPT } from '../src/main/ai-context.js'

const config = { settings: { ...DEFAULT_AI_SETTINGS, baseUrl: 'http://localhost/v1', model: 'test' }, token: 'test-token' }
const message = (id: string, text: string, role: AiMessage['role'] = 'user'): AiMessage => ({ id, text, role, conversationId: 'test', images: [], status: 'complete', error: null, model: null, createdAt: '', revision: 0, finishReason: null })
const turns = (count: number) => Array.from({ length: count }, (_, index) => [message(`u${index}`, `提问${index}`), message(`a${index}`, `答复${index}`, 'assistant')]).flat()
function setup(history: AiMessage[], summary = '记住用户的练习目标和偏好') {
  const bodies: any[] = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(String(init!.body))); return Response.json({ choices: [{ message: { content: summary }, finish_reason: 'stop' }] }) })
  const controller = new AbortController()
  const options = { config, history, checkpoint: null, signal: controller.signal, fetch: fetcher, sanitize: (text: string) => text.replaceAll('secret-token', '[已隐藏]') }
  return { bodies, fetcher, controller, options }
}

describe('fixed AI settings and context compression', () => {
  it('accepts only connection fields and replaces every old advanced value with defaults', () => {
    const settings = { ...config.settings, contextTurns: 100, stream: false, timeoutSeconds: 1800, temperature: 1.7, maxTokens: 8000, extraBody: '{invalid old JSON' }
    expect(aiSettingsInputSchema.parse({ settings, token: 'key' })).toEqual({ settings: config.settings, token: 'key' })
    expect(aiSettingsInputSchema.parse({ settings: { baseUrl: config.settings.baseUrl, model: 'test' } }).settings).toEqual(config.settings)
  })
  it('does not compress 19 rounds or exactly 32768 characters', async () => {
    for (const history of [turns(18).concat(message('last', '第19轮')), [message('a', 'a'.repeat(AI_CONTEXT_LENGTH))]]) {
      const { options, fetcher } = setup(history)
      const result = await compactAiContext(options)
      expect(fetcher).not.toHaveBeenCalled()
      expect(result.history).toEqual(history)
      expect(result.checkpoint).toBeNull()
    }
  })
  it('compresses immediately above the character limit, retaining the current question and images', async () => {
    const history = [message('old', 'a'.repeat(32000)), message('answer', 'b'.repeat(1000), 'assistant'), { ...message('new', '最新问题'), images: [{ id: 'photo', name: '谱例.png', dataUrl: 'data:image/png;base64,aaa' }] }]
    const { options, bodies } = setup(history)
    const result = await compactAiContext(options)
    expect(result.history).toEqual([history[2]])
    expect(result.checkpoint?.throughMessageId).toBe('answer')
    expect(result.summary.length + result.history.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(AI_CONTEXT_LENGTH)
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies[0].messages[0].content).toBe(AI_SUMMARY_PROMPT)
    expect(history).toHaveLength(3)
  })
  it('chunks oversized legacy history and folds the previous summary into subsequent summaries', async () => {
    const { options, bodies } = setup(turns(20).map(item => ({ ...item, text: '旧内容'.repeat(2000) })))
    options.history.push(message('latest', 'secret-token 请继续'))
    const result = await compactAiContext(options)
    expect(bodies.length).toBeGreaterThan(1)
    for (const body of bodies) {
      expect(body.messages[1].content.length).toBeLessThanOrEqual(AI_CONTEXT_LENGTH)
      expect(JSON.stringify(body)).not.toContain('secret-token')
    }
    expect(bodies[1].messages[1].content).toContain(result.summary)
    expect(result.history.at(-1)?.id).toBe('latest')
  })
  it('shrinks the summary when the latest message consumes almost all of the character budget', async () => {
    const { options } = setup([...turns(2), message('latest', '字'.repeat(32000))], '摘要'.repeat(2000))
    const result = await compactAiContext({ ...options, checkpoint: { throughMessageId: 'a0', summary: '旧摘要'.repeat(1000) } })
    expect(result.history.map(item => item.id)).toEqual(['latest'])
    expect(result.summary.length).toBeLessThanOrEqual(768)
    expect(result.checkpoint?.throughMessageId).toBe('a1')
  })
  it('preserves the previous checkpoint on failure or cancellation and never runs after pre-cancellation', async () => {
    const checkpoint = { throughMessageId: 'a0', summary: '已有摘要' }
    const { options, fetcher, controller } = setup([...turns(22), message('latest', '继续')])
    fetcher.mockRejectedValueOnce(new Error('network offline'))
    await expect(compactAiContext({ ...options, checkpoint })).rejects.toThrow('上下文自动压缩失败，完整历史已保留')
    expect(checkpoint).toEqual({ throughMessageId: 'a0', summary: '已有摘要' })
    controller.abort()
    await expect(compactAiContext({ ...options, checkpoint })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('excludes failed turns and ignores checkpoints whose messages are missing', async () => {
    const history = [message('u0', '失败的问题'), { ...message('a0', '部分输出', 'assistant'), status: 'error' as const }, message('u1', '新问题')]
    const { options, fetcher } = setup(history)
    const result = await compactAiContext({ ...options, checkpoint: { throughMessageId: 'missing', summary: '不应复用' } })
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.history.map(item => item.id)).toEqual(['u1'])
    expect(result.summary).toBe('')
  })
})
