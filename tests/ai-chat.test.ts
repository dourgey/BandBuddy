import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiEvent, type AiMessage, type AiSettings } from '../packages/shared/src/ai.js'
import { aiCompletionUrl, aiSettingsInputSchema, aiSettingsSchema, parseAiExtraBody } from '../packages/shared/src/ai-schema.js'
import { AiService } from '../src/main/ai-service.js'
import { AiStore } from '../src/main/ai-store.js'
import { buildAiRequest, requestAiCompletion, validateAiImages } from '../src/main/ai-provider.js'
import type { AiProviderConfig } from '../src/main/ai-defaults.js'
import { AI_INTENT_PROMPT, BANGBANG_PERSONA, type AiContextReader, type AiIntent } from '../src/main/ai-assistant.js'
import { AI_SUMMARY_PROMPT } from '../src/main/ai-context.js'

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  return { default: class extends DatabaseSync {
    pragma(value: string) { this.exec(`PRAGMA ${value}`) }
    transaction(fn: () => unknown) { return () => { this.exec('BEGIN'); try { const result = fn(); this.exec('COMMIT'); return result } catch (error) { this.exec('ROLLBACK'); throw error } } }
  } }
})

const roots: string[] = [], services: AiService[] = [], servers: Server[] = []
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='
const photo = () => ({ id: randomUUID(), name: '测试图片.png', dataUrl: png })
const codec = { encrypt: vi.fn((text: string) => `sealed:${Buffer.from(text).toString('base64')}`), decrypt: vi.fn((value: string) => Buffer.from(value.slice(7), 'base64').toString()) }
const builtin: AiProviderConfig = { settings: { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://builtin.invalid/v1', model: 'hidden-model' }, token: 'hidden-token' }
const databases = new WeakMap<AiService, string>()
function file(): string { const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-ai-')); roots.push(root); return path.join(root, 'ai-chat.db') }
function service(database = file(), fetcher: typeof fetch = fetch, defaults: AiProviderConfig = builtin, reader?: AiContextReader) {
  const events: AiEvent[] = []
  const isolatedFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'builtin.invalid') return Promise.reject(new Error('Mock built-in service unavailable'))
    if (url.hostname !== '127.0.0.1') throw new Error('External requests are disabled in AI tests')
    return fetcher(input, init)
  }
  const ai = new AiService(database, codec, event => events.push(event), isolatedFetch, defaults, reader)
  databases.set(ai, database)
  services.push(ai)
  return { ai, events, database }
}
async function endpoint(handle: (request: IncomingMessage, response: ServerResponse, body: Record<string, any>) => void, classify: () => AiIntent = () => ({ intent: 'other', topics: [], scopes: [] })) {
  const requests: { body: Record<string, any>; authorization?: string; url?: string }[] = []
  const routing: { body: Record<string, any>; authorization?: string }[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    if (body.messages?.[0]?.content.startsWith(AI_INTENT_PROMPT)) {
      routing.push({ body, authorization: request.headers.authorization })
      jsonReply(response, JSON.stringify(classify()))
      return
    }
    requests.push({ body, authorization: request.headers.authorization, url: request.url })
    handle(request, response, body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/v1`, requests, routing }
}
function jsonReply(response: ServerResponse, text = '收到图片，继续交流。') {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ model: 'local-test-model', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
}
function configure(ai: AiService, baseUrl: string, patch: Partial<AiSettings> = {}) {
  ai.saveSettings({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl, model: 'vision-model', ...patch }, token: 'qa-local-token' })
  // Conversation tests start from a previously checked configuration; validation has separate coverage.
  const store = new AiStore(databases.get(ai)!)
  store.setVerified(store.settings().revision, true)
  store.close()
  return ai.getSettings()
}
async function finished(ai: AiService, id: string) {
  await vi.waitFor(() => expect(ai.get(id)?.messages.at(-1)?.status).not.toBe('streaming'), { timeout: 4000, interval: 10 })
  return ai.get(id)!
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(ai => ai.shutdown()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
  codec.decrypt.mockImplementation(value => Buffer.from(value.slice(7), 'base64').toString())
})

describe('OpenAI compatible AI settings and requests', () => {
  it('normalizes roots, versioned prefixes and full completion endpoints without duplicating paths', () => {
    expect(aiCompletionUrl('https://example.com')).toBe('https://example.com/v1/chat/completions')
    expect(aiCompletionUrl('https://example.com/api/v2/')).toBe('https://example.com/api/v2/chat/completions')
    expect(aiCompletionUrl('http://localhost:1234/v1/chat/completions/')).toBe('http://localhost:1234/v1/chat/completions')
    for (const url of ['file:///tmp/key', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret']) expect(() => aiCompletionUrl(url)).toThrow()
  })
  it('omits optional parameters and inserts no default system prompt', () => {
    const user: AiMessage = { id: randomUUID(), conversationId: randomUUID(), role: 'user', text: 'hello', images: [], status: 'complete', error: null, model: null, createdAt: '', revision: 0, finishReason: null }
    const body = buildAiRequest({ ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.com/v1', model: 'model' }, [user])
    expect(body).toEqual({ model: 'model', messages: [{ role: 'user', content: 'hello' }], stream: true })
    const custom = buildAiRequest({ ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.com/v1', model: 'model', maxTokens: 512, tokenLimitField: 'max_completion_tokens', temperature: 0.2, extraBody: '{"enable_thinking":false}' }, [user])
    expect(custom).toMatchObject({ max_completion_tokens: 512, temperature: 0.2, enable_thinking: false })
    expect(custom).not.toHaveProperty('max_tokens')
  })
  it('rejects invalid parameters, override fields, empty messages and disguised image files', () => {
    expect(aiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, temperature: 3 }).success).toBe(false)
    expect(aiSettingsInputSchema.safeParse({ settings: DEFAULT_AI_SETTINGS, token: 'key\nInjected: header' }).success).toBe(false)
    for (const value of ['[]', 'null', '{', '{"messages":[]}', '{"tools":[]}', '{"max_tokens":2}']) expect(() => parseAiExtraBody(value)).toThrow()
    expect(() => validateAiImages([photo()])).not.toThrow()
    expect(() => validateAiImages([{ ...photo(), dataUrl: 'data:image/png;base64,SGVsbG8=' }])).toThrow('图片内容无效')
    const { ai } = service()
    expect(() => ai.send({ conversationId: randomUUID(), text: ' ', images: [] })).toThrow()
    expect(() => ai.send({ conversationId: randomUUID(), text: '', images: Array.from({ length: 5 }, photo) })).toThrow()
  })
  it('encrypts the token, never returns it, preserves/clears it, and propagates encryption failures', () => {
    const { ai } = service()
    const settings = configure(ai, 'https://example.com/v1')
    expect(settings.hasToken).toBe(true)
    expect(JSON.stringify(ai.getSettings())).not.toContain('qa-local-token')
    expect(codec.encrypt).toHaveBeenCalledWith('qa-local-token')
    expect(ai.saveSettings({ settings: settings.settings }).hasToken).toBe(true)
    expect(ai.saveSettings({ settings: settings.settings, token: null }).hasToken).toBe(false)
    codec.encrypt.mockImplementationOnce(() => { throw new Error('系统密钥存储不可用') })
    expect(() => configure(ai, 'https://example.com/v1')).toThrow('密钥存储')
    expect(ai.getSettings().hasToken).toBe(false)
  })
  it('migrates existing settings without treating an older untested configuration as verified', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const database = file(), legacy = new DatabaseSync(database)
    legacy.exec('CREATE TABLE ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, token TEXT)')
    const settings = { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.com/v1', model: 'old-model' }
    legacy.prepare('INSERT INTO ai_settings VALUES(1,?,?)').run(JSON.stringify({ ...settings, contextTurns: 100, stream: false, extraBody: 'invalid legacy value' }), codec.encrypt('old-user-token'))
    legacy.close()
    const { ai } = service(database)
    expect(ai.getSettings()).toEqual({ settings, hasToken: true, verified: false })
    expect(ai.saveSettings({ settings }).verified).toBe(false)
    const saved = new DatabaseSync(database)
    expect(JSON.parse((saved.prepare('SELECT json FROM ai_settings').get() as { json: string }).json)).toEqual({ baseUrl: settings.baseUrl, model: settings.model })
    saved.close()
  })
})

describe('persisted AI conversations with a real loopback HTTP provider', () => {
  it('prompts for configuration without contacting the default provider when its token is absent', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const { ai } = service(file(), fetcher, { ...builtin, token: '' })
    const conversation = ai.create()
    ai.send({ conversationId: conversation.id, text: '你好', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)).toMatchObject({ status: 'error', error: expect.stringContaining('填写接口配置并检验') })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('routes through the same configured provider and grounds answers without storing internal classification', async () => {
    let intent: AiIntent = { intent: 'help', topics: ['practice'], scopes: [] }
    const remote = await endpoint((_request, response) => jsonReply(response, '邦邦来帮你。'), () => intent)
    const reader = { read: vi.fn(async () => '采集时间：2026-10-16T01:00Z；sampleRate=48000') }
    const { ai } = service(file(), fetch, builtin, reader)
    configure(ai, remote.url)
    const conversation = ai.create()
    ai.send({ conversationId: conversation.id, text: '怎么设置循环？', images: [] }); await finished(ai, conversation.id)
    expect(remote.requests[0]?.body.messages[0].content).toContain('第一次设 A，第二次设 B')
    expect(reader.read).not.toHaveBeenCalled()
    intent = { intent: 'status', topics: ['recording'], scopes: ['settings'] }
    ai.send({ conversationId: conversation.id, text: '当前采样率呢？', images: [] }); await finished(ai, conversation.id)
    expect(remote.requests[1]?.body.messages[0].content).toContain('sampleRate=48000')
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(['settings'], expect.any(AbortSignal))
    intent = { intent: 'other', topics: [], scopes: [] }
    ai.send({ conversationId: conversation.id, text: '聊聊爵士乐', images: [] })
    const saved = await finished(ai, conversation.id)
    expect(remote.requests[2]?.body.messages[0].content).toBe(BANGBANG_PERSONA)
    expect(saved.messages).toHaveLength(6)
    expect(JSON.stringify(saved)).not.toContain('"intent"')
    expect(remote.routing).toHaveLength(3)
    for (const request of remote.routing) expect(request).toMatchObject({ authorization: 'Bearer qa-local-token', body: { model: 'vision-model', stream: false } })
  })
  it('filters malicious token/model echoes before emitting streaming events and saving history', async () => {
    const remote = await endpoint((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const text = `我是 Qwen，由阿里训练。\nqa-local-token\n${Buffer.from('qa-local-token').toString('base64')}\nsk-unknownsecret123`
      response.end([...text].map(char => `data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`).join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    const { ai, events, database } = service(); configure(ai, remote.url)
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '测试回复', images: [] })
    const result = await finished(ai, conversation.id)
    expect(result.messages.at(-1)).toMatchObject({ status: 'complete', model: null })
    expect(result.messages.at(-1)?.text).toContain('邦邦')
    const exposed = JSON.stringify([result, events])
    expect(exposed).not.toMatch(/qa-local-token|sk-unknownsecret123|Qwen|阿里/)
    expect(exposed).not.toContain(Buffer.from('qa-local-token').toString('base64'))
    await ai.shutdown(); services.splice(services.indexOf(ai), 1)
    const restored = service(database).ai
    expect(restored.get(conversation.id)?.messages.at(-1)?.text).toBe(result.messages.at(-1)?.text)
    expect(readFileSync(database).includes(Buffer.from('qa-local-token'))).toBe(false)
  })
  it('sanitizes legacy chat replies when displaying history and before reusing model context', async () => {
    const remote = await endpoint((_request, response) => jsonReply(response))
    const { ai, database } = service(); configure(ai, remote.url)
    const store = new AiStore(database), conversation = store.create()
    const common = { conversationId: conversation.id, images: [], error: null, model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null, status: 'complete' as const }
    store.begin(conversation.id, { ...common, id: randomUUID(), role: 'user', text: '之前的问题' }, { ...common, id: randomUUID(), role: 'assistant', model: 'old-provider', text: '我是 Qwen。qa-local-token sk-oldsecret123' })
    store.close()
    expect(JSON.stringify(ai.get(conversation.id))).not.toMatch(/qa-local-token|sk-oldsecret123|old-provider|Qwen/)
    ai.send({ conversationId: conversation.id, text: '继续', images: [] }); await finished(ai, conversation.id)
    expect(JSON.stringify(remote.requests.map(request => request.body))).not.toMatch(/qa-local-token|sk-oldsecret123|old-provider/)
  })
  it('uses built-in text/image chat without exposing its settings or response model', async () => {
    const remote = await endpoint((_request, response) => jsonReply(response, '内置回复'))
    const defaults = { ...builtin, settings: { ...builtin.settings, baseUrl: remote.url } }
    const { ai, events, database } = service(file(), fetch, defaults)
    expect(ai.getSettings()).toEqual({ settings: DEFAULT_AI_SETTINGS, hasToken: false, verified: false })
    const conversation = ai.create()
    const initial = ai.send({ conversationId: conversation.id, text: '图片问题', images: [photo()] })
    expect(initial.messages.at(-1)?.model).toBeNull()
    const result = await finished(ai, conversation.id)
    expect(result.messages.at(-1)).toMatchObject({ text: '内置回复', status: 'complete', model: null })
    expect(remote.requests[0]).toMatchObject({ authorization: 'Bearer hidden-token', body: { model: 'hidden-model' } })
    expect(remote.requests[0]?.body.messages[0]).toEqual({ role: 'system', content: BANGBANG_PERSONA })
    const exposed = JSON.stringify([ai.getSettings(), result, events])
    for (const value of [defaults.token, defaults.settings.baseUrl, defaults.settings.model, 'local-test-model']) expect(exposed).not.toContain(value)
    await ai.shutdown(); services.splice(services.indexOf(ai), 1)
    for (const value of [defaults.token, defaults.settings.baseUrl, defaults.settings.model]) expect(readFileSync(database).includes(Buffer.from(value))).toBe(false)
  })
  it('keeps unchecked/failed custom settings inactive, then enables checked settings across restarts', async () => {
    const internal = await endpoint((_request, response) => jsonReply(response, '内置回复'))
    let valid = false
    const custom = await endpoint((_request, response) => {
      if (valid) { jsonReply(response, '自定义回复'); return }
      response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'bad custom-test-token' } }))
    })
    const defaults = { ...builtin, settings: { ...builtin.settings, baseUrl: internal.url } }
    const { ai, database } = service(file(), fetch, defaults)
    const input = { settings: { ...DEFAULT_AI_SETTINGS, baseUrl: custom.url, model: 'custom-model' }, token: 'custom-test-token' }
    ai.saveSettings(input)
    const conversation = ai.create()
    ai.send({ conversationId: conversation.id, text: '未检验', images: [] }); await finished(ai, conversation.id)
    expect(custom.requests).toHaveLength(0)
    expect(internal.requests).toHaveLength(1)
    await expect(ai.testSettings(input)).rejects.toThrow('401')
    expect(ai.getSettings().verified).toBe(false)
    ai.send({ conversationId: conversation.id, text: '检验失败后', images: [] }); await finished(ai, conversation.id)
    expect(internal.requests).toHaveLength(2)
    valid = true
    await ai.testSettings(input)
    expect(ai.getSettings().verified).toBe(true)
    ai.send({ conversationId: conversation.id, text: '检验成功后', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)?.text).toBe('自定义回复')
    expect(custom.requests.at(-1)).toMatchObject({ authorization: 'Bearer custom-test-token', body: { model: 'custom-model' } })
    await ai.shutdown(); services.splice(services.indexOf(ai), 1)
    const restored = service(database, fetch, defaults).ai
    expect(restored.getSettings().verified).toBe(true)
    restored.send({ conversationId: conversation.id, text: '重启后', images: [] }); await finished(restored, conversation.id)
    expect(custom.requests.at(-1)?.body.messages.at(-1)?.content).toBe('重启后')
    expect(restored.saveSettings({ settings: input.settings }).verified).toBe(true)
    expect(restored.saveSettings({ ...input, settings: { ...input.settings, model: 'changed-model' } }).verified).toBe(false)
    restored.send({ conversationId: conversation.id, text: '更改参数后', images: [] }); await finished(restored, conversation.id)
    expect(internal.requests).toHaveLength(3)
  })
  it('falls back after a checked custom service fails before output and does not retry it on later turns', async () => {
    let failed = false
    const custom = await endpoint((_request, response) => {
      if (!failed) { jsonReply(response, 'OK'); return }
      response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"unavailable"}}')
    })
    const internal = await endpoint((_request, response) => jsonReply(response, '继续回复'))
    const { ai, events } = service(file(), fetch, { ...builtin, settings: { ...builtin.settings, baseUrl: internal.url } })
    await ai.testSettings({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: custom.url, model: 'custom-model' }, token: 'custom-test-token' })
    failed = true
    const conversation = ai.create()
    ai.send({ conversationId: conversation.id, text: '第一轮', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)).toMatchObject({ status: 'complete', text: '继续回复', model: null, error: null })
    expect(ai.getSettings().verified).toBe(false)
    ai.send({ conversationId: conversation.id, text: '第二轮', images: [] }); await finished(ai, conversation.id)
    expect(custom.requests).toHaveLength(2)
    expect(internal.requests).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('hidden-token')
  })
  it('cannot activate an obsolete configuration when a connection test finishes late', async () => {
    let reply: ServerResponse | undefined
    const remote = await endpoint((_request, response) => { reply = response })
    const { ai } = service()
    const input = { settings: { ...DEFAULT_AI_SETTINGS, baseUrl: remote.url, model: 'old-model' }, token: 'old-token' }
    const pending = expect(ai.testSettings(input)).rejects.toThrow('配置已更改')
    await vi.waitFor(() => expect(reply).toBeDefined())
    ai.saveSettings({ settings: { ...input.settings, model: 'new-model' }, token: 'new-token' })
    jsonReply(reply!, 'OK')
    await pending
    expect(ai.getSettings()).toMatchObject({ settings: { model: 'new-model' }, verified: false })
  })
  it('keeps a failed partial reply and uses the built-in service when retrying it', async () => {
    const custom = await endpoint((_request, response, body) => {
      if (!body.stream) { jsonReply(response, 'OK'); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n')
    })
    const internal = await endpoint((_request, response) => jsonReply(response, '完整回复'))
    const { ai } = service(file(), fetch, { ...builtin, settings: { ...builtin.settings, baseUrl: internal.url } })
    await ai.testSettings({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: custom.url, model: 'custom-model' }, token: 'custom-test-token' })
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '测试', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)).toMatchObject({ status: 'error', text: '部分内容' })
    expect(ai.getSettings().verified).toBe(false)
    expect(internal.requests).toHaveLength(0)
    ai.retry(conversation.id)
    const result = await finished(ai, conversation.id)
    expect(result.messages).toHaveLength(2)
    expect(result.messages.at(-1)).toMatchObject({ status: 'complete', text: '完整回复', model: null })
    expect(internal.requests[0]?.body.messages).toEqual([{ role: 'system', content: BANGBANG_PERSONA }, { role: 'user', content: '测试' }])
  })
  it('does not send a fallback request after the user stops a checked service before any output', async () => {
    const custom = await endpoint((_request, response, body) => {
      if (!body.stream) { jsonReply(response, 'OK'); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': waiting\n\n')
    })
    const internal = await endpoint((_request, response) => jsonReply(response))
    const { ai } = service(file(), fetch, { ...builtin, settings: { ...builtin.settings, baseUrl: internal.url } })
    await ai.testSettings({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: custom.url, model: 'custom-model' }, token: 'custom-test-token' })
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '测试', images: [] })
    await vi.waitFor(() => expect(custom.requests).toHaveLength(2))
    await ai.cancel(conversation.id)
    expect(ai.get(conversation.id)?.messages.at(-1)?.status).toBe('cancelled')
    expect(internal.requests).toHaveLength(0)
    expect(ai.getSettings().verified).toBe(true)
  })
  it('uses the built-in service if a checked user token can no longer be decrypted', async () => {
    const custom = await endpoint((_request, response) => jsonReply(response, 'OK'))
    const internal = await endpoint((_request, response) => jsonReply(response, '内置回复'))
    const { ai } = service(file(), fetch, { ...builtin, settings: { ...builtin.settings, baseUrl: internal.url } })
    await ai.testSettings({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: custom.url, model: 'custom-model' }, token: 'custom-test-token' })
    codec.decrypt.mockImplementation(() => { throw new Error('unavailable') })
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '测试', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)).toMatchObject({ status: 'complete', text: '内置回复', model: null })
    expect(ai.getSettings().verified).toBe(false)
    expect(custom.requests).toHaveLength(1)
  })
  it('redacts built-in credentials and provider identity from error messages', async () => {
    const remote = await endpoint((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `hidden-token hidden-model ${remote.url}` } }))
    })
    const { ai, events } = service(file(), fetch, { ...builtin, settings: { ...builtin.settings, baseUrl: remote.url } })
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '测试', images: [] })
    const result = await finished(ai, conversation.id)
    expect(result.messages.at(-1)).toMatchObject({ status: 'error', model: null })
    const exposed = JSON.stringify([result, events])
    for (const value of ['hidden-token', 'hidden-model', remote.url]) expect(exposed).not.toContain(value)
  })
  it('sends text and images, isolates conversations, restores settings/history, renames and cascades deletion', async () => {
    const remote = await endpoint((_request, response) => jsonReply(response))
    const { ai, database } = service()
    configure(ai, remote.url)
    const first = ai.create(), second = ai.create(), image = photo()
    ai.send({ conversationId: first.id, text: '看一下这张图片', images: [image] })
    const result = await finished(ai, first.id)
    expect(result.title).toBe('看一下这张图片')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]).toMatchObject({ status: 'complete', text: '收到图片，继续交流。', model: null })
    expect(ai.get(second.id)?.messages).toHaveLength(0)
    expect(remote.requests[0]).toMatchObject({ authorization: 'Bearer qa-local-token', url: '/v1/chat/completions', body: { model: 'vision-model', messages: [{ role: 'system', content: BANGBANG_PERSONA }, { role: 'user', content: [{ type: 'text', text: '看一下这张图片' }, { type: 'image_url', image_url: { url: png, detail: 'auto' } }] }] } })
    ai.rename(first.id, '乐理图片')
    await ai.shutdown(); services.splice(services.indexOf(ai), 1)
    expect(readFileSync(database).includes(Buffer.from('qa-local-token'))).toBe(false)
    const restored = service(database).ai
    expect(restored.get(first.id)).toMatchObject({ title: '乐理图片', messages: [{ images: [image] }, { text: '收到图片，继续交流。' }] })
    expect(restored.getSettings().hasToken).toBe(true)
    restored.delete(first.id)
    expect(restored.get(first.id)).toBeNull()
    expect(restored.list().map(item => item.id)).toEqual([second.id])
  })
  it('ignores legacy advanced settings and preserves all history below the fixed context limit', async () => {
    const remote = await endpoint((_request, response) => jsonReply(response, '答复'))
    const { ai } = service(); configure(ai, remote.url, { contextTurns: 2, stream: false })
    const conversation = ai.create()
    for (const text of ['第一轮', '第二轮', '第三轮']) { ai.send({ conversationId: conversation.id, text, images: [] }); await finished(ai, conversation.id) }
    expect(remote.requests[2]?.body.messages.map((item: any) => item.content)).toEqual([BANGBANG_PERSONA, '第一轮', '答复', '第二轮', '答复', '第三轮'])
    expect(remote.requests[2]?.body.stream).toBe(true)
    expect(ai.getSettings().settings).toEqual({ ...DEFAULT_AI_SETTINGS, baseUrl: remote.url, model: 'vision-model' })
    expect(ai.get(conversation.id)?.messages).toHaveLength(6)
  })
  it('compresses at round 20, persists the checkpoint across restarts and compresses again without losing local history', async () => {
    const remote = await endpoint((_request, response, body) => jsonReply(response, body.messages[0]?.content === AI_SUMMARY_PROMPT ? '用户正在练习 A 小调，目标速度 120 BPM。' : '答复'))
    const { ai, database } = service(); configure(ai, remote.url)
    const conversation = ai.create()
    for (let round = 1; round <= 19; round++) { ai.send({ conversationId: conversation.id, text: `第 ${round} 轮`, images: [] }); await finished(ai, conversation.id) }
    expect(remote.requests.filter(item => item.body.messages[0]?.content === AI_SUMMARY_PROMPT)).toHaveLength(0)
    ai.send({ conversationId: conversation.id, text: '第 20 轮', images: [] }); await finished(ai, conversation.id)
    const summaries = () => remote.requests.filter(item => item.body.messages[0]?.content === AI_SUMMARY_PROMPT)
    expect(summaries()).toHaveLength(1)
    expect(remote.requests.at(-1)?.body.messages).toHaveLength(8)
    expect(remote.requests.at(-1)?.body.messages[0].content).toContain('120 BPM')
    expect(remote.requests.at(-1)?.body.messages[1].content).toBe('第 17 轮')
    expect(ai.get(conversation.id)?.messages).toHaveLength(40)
    await ai.shutdown(); services.splice(services.indexOf(ai), 1)
    const restored = service(database).ai
    for (let round = 21; round <= 36; round++) { restored.send({ conversationId: conversation.id, text: `第 ${round} 轮`, images: [] }); await finished(restored, conversation.id) }
    expect(summaries()).toHaveLength(2)
    expect(summaries()[1]?.body.messages[1].content).toContain('120 BPM')
    expect(restored.get(conversation.id)?.messages).toHaveLength(72)
    const store = new AiStore(database)
    expect(store.context(conversation.id)?.summary).toContain('120 BPM')
    restored.delete(conversation.id)
    expect(store.context(conversation.id)).toBeNull()
    store.close()
  })
  it('preserves history and checked settings when compression fails, then retries successfully', async () => {
    let rejectSummary = true
    const remote = await endpoint((_request, response, body) => {
      if (body.messages[0]?.content === AI_SUMMARY_PROMPT && rejectSummary) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":{"message":"summary temporarily unavailable"}}'); return }
      jsonReply(response, body.messages[0]?.content === AI_SUMMARY_PROMPT ? '保留练习目标' : '答复')
    })
    const { ai, database } = service(); configure(ai, remote.url)
    const conversation = ai.create(), store = new AiStore(database)
    const common = { conversationId: conversation.id, images: [], error: null, model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null, status: 'complete' as const }
    store.begin(conversation.id, { ...common, id: randomUUID(), role: 'user', text: '原始提问'.repeat(4000) }, { ...common, id: randomUUID(), role: 'assistant', text: '原始回复'.repeat(5000) })
    ai.send({ conversationId: conversation.id, text: '继续', images: [] })
    const failed = await finished(ai, conversation.id)
    expect(failed.messages.at(-1)?.error).toContain('上下文自动压缩失败')
    expect(ai.getSettings().verified).toBe(true)
    expect(store.context(conversation.id)).toBeNull()
    expect(failed.messages).toHaveLength(4)
    rejectSummary = false; ai.retry(conversation.id)
    expect((await finished(ai, conversation.id)).messages.at(-1)?.status).toBe('complete')
    expect(store.context(conversation.id)?.summary).toBe('保留练习目标')
    expect(ai.get(conversation.id)?.messages).toHaveLength(4)
    store.close()
  })
  it('cancels an in-flight summary without writing a checkpoint or sending an answer', async () => {
    const remote = await endpoint((_request, response, body) => {
      if (body.messages[0]?.content === AI_SUMMARY_PROMPT) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': summarizing\n\n'); return }
      jsonReply(response)
    })
    const { ai, database } = service(); configure(ai, remote.url)
    const conversation = ai.create(), store = new AiStore(database)
    const common = { conversationId: conversation.id, images: [], error: null, model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null, status: 'complete' as const }
    store.begin(conversation.id, { ...common, id: randomUUID(), role: 'user', text: '原始提问'.repeat(4000) }, { ...common, id: randomUUID(), role: 'assistant', text: '原始回复'.repeat(5000) })
    ai.send({ conversationId: conversation.id, text: '继续', images: [] })
    await vi.waitFor(() => expect(remote.requests).toHaveLength(1))
    await ai.cancel(conversation.id)
    expect(ai.get(conversation.id)?.messages.at(-1)?.status).toBe('cancelled')
    expect(ai.get(conversation.id)?.messages).toHaveLength(4)
    expect(store.context(conversation.id)).toBeNull()
    expect(remote.routing).toHaveLength(0)
    expect(ai.getSettings().verified).toBe(true)
    store.close()
  })
  it('decodes split UTF-8 SSE frames, comments, CRLF, usage events, and final events', async () => {
    const remote = await endpoint((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frames = ': ping\r\n\r\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] }) + '\r\n\r\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '你好🎸' } }] }) + '\r\n\r\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: {"choices":[],"usage":{"total_tokens":9}}\n\ndata: [DONE]\n\n'
      const bytes = Buffer.from(frames)
      const split = bytes.indexOf(Buffer.from('你')) + 1
      response.write(bytes.subarray(0, split))
      setTimeout(() => response.end(bytes.subarray(split)), 15)
    })
    const { ai, events } = service(); configure(ai, remote.url)
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '你好', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)).toMatchObject({ text: '你好🎸', status: 'complete', finishReason: 'stop' })
    expect(events.some(event => event.type === 'message' && event.message.status === 'streaming' && event.message.text === '你好🎸')).toBe(true)
  })
  it('stops a hanging stream, retains partial output, retries without duplicating the user message, and prevents double sends', async () => {
    let calls = 0
    const remote = await endpoint((_request, response) => {
      if (++calls > 1) { jsonReply(response, '重试成功'); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"index":0,"delta":{"content":"部分回复"}}]}\n\n')
    })
    const { ai } = service(); configure(ai, remote.url)
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '开始', images: [] })
    expect(() => ai.send({ conversationId: conversation.id, text: '重复', images: [] })).toThrow('正在生成')
    expect(() => ai.delete(conversation.id)).toThrow('先停止')
    await vi.waitFor(() => expect(ai.get(conversation.id)?.messages.at(-1)?.text).toBe('部分回复'))
    await ai.cancel(conversation.id)
    expect(ai.get(conversation.id)?.messages.at(-1)).toMatchObject({ text: '部分回复', status: 'cancelled' })
    ai.retry(conversation.id)
    const result = await finished(ai, conversation.id)
    expect(result.messages).toHaveLength(2)
    expect(result.messages.at(-1)?.text).toBe('重试成功')
    expect(remote.requests[1]?.body.messages).toEqual([{ role: 'system', content: BANGBANG_PERSONA }, { role: 'user', content: '开始' }])
  })
  it('excludes failed turns from later context after a checked configuration is restored', async () => {
    let calls = 0
    const remote = await endpoint((_request, response) => {
      if (++calls > 1) { jsonReply(response); return }
      response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'bad qa-local-token Bearer qa-local-token' } }))
    })
    const { ai } = service(); configure(ai, remote.url)
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '失败的提问', images: [] })
    const result = await finished(ai, conversation.id)
    expect(result.messages.at(-1)?.status).toBe('error')
    expect(JSON.stringify(result)).not.toContain('qa-local-token')
    configure(ai, remote.url)
    ai.send({ conversationId: conversation.id, text: '新的提问', images: [] }); await finished(ai, conversation.id)
    expect(remote.requests[1]?.body.messages).toEqual([{ role: 'system', content: BANGBANG_PERSONA }, { role: 'user', content: '新的提问' }])
  })
  it('checks and enables the actual form, saves encrypted credentials and creates no conversation', async () => {
    const remote = await endpoint((_request, response) => jsonReply(response, 'OK'))
    const { ai } = service()
    const result = await ai.testSettings({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: remote.url, model: 'test-model' }, token: 'temporary-token' })
    expect(result.model).toBe('local-test-model')
    expect(ai.list()).toHaveLength(0)
    expect(ai.getSettings()).toEqual({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: remote.url, model: 'test-model' }, hasToken: true, verified: true })
    expect(remote.requests[0]).toMatchObject({ authorization: 'Bearer temporary-token', body: { stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }] } })
  })
  it('marks a truncated SSE response as failed while preserving its received content', async () => {
    const remote = await endpoint((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"中途断开"}}]}\n\n')
    })
    const { ai } = service(); configure(ai, remote.url)
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '测试', images: [] })
    expect((await finished(ai, conversation.id)).messages.at(-1)).toMatchObject({ text: '中途断开', status: 'error' })
  })
  it('recovers an unfinished persisted reply after a crash', () => {
    const database = file(), store = new AiStore(database), conversation = store.create()
    const common = { conversationId: conversation.id, images: [], error: null, model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null }
    store.begin(conversation.id, { ...common, id: randomUUID(), role: 'user', status: 'complete', text: '图片问题' }, { ...common, id: randomUUID(), role: 'assistant', status: 'streaming', text: '已收到一半' })
    store.close()
    const recovered = service(database).ai.get(conversation.id)!
    expect(recovered.messages.at(-1)).toMatchObject({ status: 'cancelled', text: '已收到一半', revision: 1 })
  })
  it('aborts active requests before closing the history database on shutdown', async () => {
    const remote = await endpoint((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': waiting\n\n') })
    const { ai, database } = service(); configure(ai, remote.url)
    const conversation = ai.create(); ai.send({ conversationId: conversation.id, text: '等待', images: [] })
    await vi.waitFor(() => expect(remote.requests).toHaveLength(1))
    await ai.shutdown(); services.splice(services.indexOf(ai), 1)
    expect(service(database).ai.get(conversation.id)?.messages.at(-1)?.status).toBe('cancelled')
  })
  it('rejects redirects instead of forwarding the Authorization header to a different endpoint', async () => {
    const remote = await endpoint((_request, response) => { response.writeHead(302, { Location: 'http://127.0.0.1:1/steal' }); response.end() })
    await expect(requestAiCompletion({ settings: { ...DEFAULT_AI_SETTINGS, baseUrl: remote.url }, body: {}, token: 'sensitive', signal: new AbortController().signal, fetch, onText: () => {} })).rejects.toThrow()
    expect(remote.requests).toHaveLength(1)
  })
})
