import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { type AiConversation, type AiEvent, type AiMessage, type AiSettingsInput, type AiSettingsView } from '@shared/ai.js'
import { aiSendSchema, aiSettingsInputSchema } from '@shared/ai-schema.js'
import { AiStore } from './ai-store.js'
import { aiErrorMessage, buildAiRequest, requestAiCompletion, validateAiImages } from './ai-provider.js'
import { BUILTIN_AI_CONFIG, type AiProviderConfig } from './ai-defaults.js'
import { prepareAiAnswer, type AiContextReader } from './ai-assistant.js'
import { guardAiReply, redactAiSecrets } from './ai-security.js'
import { AiContextCompressionError, compactAiContext } from './ai-context.js'

export interface AiSecretCodec { encrypt(token: string): string; decrypt(value: string): string }
interface Run { controller: AbortController; task: Promise<void> }

export class AiService {
  private storage: AiStore | null = null
  private runs = new Map<string, Run>()
  private tests = new Set<Run>()
  private closing = false
  constructor(private readonly file: string, private readonly codec: AiSecretCodec, private readonly emit: (event: AiEvent) => void, private readonly fetcher: typeof globalThis.fetch = globalThis.fetch, private readonly builtin: AiProviderConfig = BUILTIN_AI_CONFIG, private readonly reader?: AiContextReader) {}
  private get store(): AiStore {
    if (this.closing) throw new Error('应用正在退出。')
    return this.storage ??= new AiStore(this.file)
  }
  getSettings(): AiSettingsView {
    const value = this.store.settings()
    return { settings: value.settings, hasToken: !!value.token, verified: value.verified }
  }
  saveSettings(raw: unknown): AiSettingsView {
    const { settings, token } = aiSettingsInputSchema.parse(raw), previous = this.store.settings()
    const encrypted = token === undefined ? previous.token : token === null ? null : this.codec.encrypt(token)
    let sameToken = token === undefined || (token === null && !previous.token)
    if (typeof token === 'string') { try { sameToken = token === this.token() } catch { sameToken = false } }
    const verified = previous.verified && sameToken && JSON.stringify(settings) === JSON.stringify(previous.settings)
    this.store.saveSettings(settings, encrypted, verified)
    this.emit({ type: 'settings' })
    return { settings, hasToken: !!encrypted, verified }
  }
  private userError(error: unknown, token = ''): string {
    let message = error instanceof Error ? error.message : 'AI 请求失败，请检查接口设置后重试。'
    for (const secret of [this.builtin.token, this.builtin.settings.baseUrl, new URL(this.builtin.settings.baseUrl).hostname, this.builtin.settings.model]) {
      if (secret) message = message.split(secret).join('[已隐藏]')
    }
    return redactAiSecrets(aiErrorMessage(new Error(message), token), [token, this.builtin.token])
  }
  private token(input?: AiSettingsInput): string {
    if (input?.token !== undefined) return input.token ?? ''
    const encrypted = this.store.settings().token
    if (!encrypted) return ''
    try { return this.codec.decrypt(encrypted) } catch { throw new Error('无法解密已保存的 Token，请在 AI 设置中重新填写并保存。') }
  }
  private secrets(extra = ''): string[] {
    const secrets = [this.builtin.token, extra]
    try { secrets.push(this.token()) } catch { /* A lost system key must not prevent safe history display. */ }
    return secrets
  }
  private view(conversation: AiConversation): AiConversation {
    const secrets = this.secrets(), models = [this.builtin.settings.model, this.store.settings().settings.model]
    return { ...conversation, messages: conversation.messages.map(message => ({ ...message,
      text: message.role === 'assistant' ? guardAiReply(message.text, secrets, models, true) : redactAiSecrets(message.text, secrets),
      model: null, error: message.error ? redactAiSecrets(message.error, secrets) : null })) }
  }
  list() { const secrets = this.secrets(); return this.store.list().map(item => ({ ...item, title: redactAiSecrets(item.title, secrets), preview: redactAiSecrets(item.preview, secrets) })) }
  get(id: string) { const conversation = this.store.get(z.string().uuid().parse(id)); return conversation ? this.view(conversation) : null }
  create() { const result = this.store.create(); this.emit({ type: 'conversations' }); return result }
  rename(id: string, title: string): void {
    this.store.rename(z.string().uuid().parse(id), z.string().trim().min(1).max(100).parse(title))
    this.emit({ type: 'conversations' })
  }
  delete(id: string): void {
    z.string().uuid().parse(id)
    if (this.runs.has(id)) throw new Error('请先停止当前回复，再删除对话。')
    this.store.delete(id); this.emit({ type: 'conversations' })
  }
  send(raw: unknown): AiConversation {
    const input = aiSendSchema.parse(raw)
    validateAiImages(input.images)
    return this.start(input.conversationId, {
      id: randomUUID(), conversationId: input.conversationId, role: 'user', text: redactAiSecrets(input.text, this.secrets()), images: input.images,
      status: 'complete', error: null, model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null
    })
  }
  retry(id: string): AiConversation { return this.start(z.string().uuid().parse(id), null) }
  private start(id: string, user: AiMessage | null): AiConversation {
    const store = this.store
    if (this.runs.has(id)) throw new Error('该对话正在生成回复。')
    if (this.runs.size >= 3) throw new Error('最多同时进行 3 个对话，请稍后再试。')
    const conversation = store.get(id)
    if (!conversation) throw new Error('对话已不存在。')
    const last = conversation.messages.at(-1)
    if (!user && (!last || last.role !== 'assistant' || !['error', 'cancelled'].includes(last.status))) throw new Error('没有可重试的回复。')
    const saved = store.settings()
    let custom = saved.verified
    let config: AiProviderConfig = this.builtin
    if (custom) {
      try { config = { settings: saved.settings, token: this.token() } }
      catch { custom = false; store.setVerified(saved.revision, false); this.emit({ type: 'settings' }) }
    }
    const history = user ? [...conversation.messages, user] : conversation.messages.slice(0, -1)
    // Validate before inserting messages, including local attachment/context constraints.
    buildAiRequest(config.settings, history)
    const assistant: AiMessage = {
      id: randomUUID(), conversationId: id, role: 'assistant', text: '', images: [], status: 'streaming', error: null,
      model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null
    }
    const result = store.begin(id, user, assistant, user ? undefined : last?.id)
    const controller = new AbortController()
    const run: Run = { controller, task: Promise.resolve() }
    this.runs.set(id, run)
    run.task = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      let attemptSignal = controller.signal
      let lastEmit = 0, lastSave = 0
      const publish = (force = false): void => {
        const now = Date.now()
        if (force || now - lastSave >= 400) {
          try { store.update(assistant); lastSave = now } catch { throw new Error('本地对话保存失败，请检查磁盘空间与目录权限。') }
        }
        if (force || now - lastEmit >= 50) { this.emit({ type: 'message', message: { ...assistant } }); lastEmit = now }
      }
      try {
        const request = async () => {
          const { settings, token } = config
          if (!custom && !token) throw new Error('请先在设置 → 实验室功能 → AI 对话中填写接口配置并检验。')
          const secrets = this.secrets(token)
          const models = [settings.model, this.builtin.settings.model]
          attemptSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(settings.timeoutSeconds * 1000)])
          const context = await compactAiContext({ config, history, checkpoint: store.context(id), signal: attemptSignal, fetch: this.fetcher, sanitize: text => redactAiSecrets(text, secrets) })
          if (context.checkpoint) store.saveContext(id, context.checkpoint)
          const prepared = await prepareAiAnswer({ config, history: context.history, summary: context.summary, secrets, reader: this.reader, signal: attemptSignal, fetch: this.fetcher })
          const completion = await requestAiCompletion({ settings, token, body: prepared.body, fetch: this.fetcher, signal: attemptSignal, onText: text => { assistant.text = guardAiReply(text, secrets, models); assistant.revision++; publish() } })
          return { ...completion, text: guardAiReply(completion.text, secrets, models, true) }
        }
        let completion
        try { completion = await request() }
        catch (error) {
          // Never mix answers or replay a user-cancelled request after a partial stream.
          if (!custom || controller.signal.aborted || error instanceof AiContextCompressionError) throw error
          if (store.setVerified(saved.revision, false)) this.emit({ type: 'settings' })
          if (assistant.text) throw error
          custom = false; config = this.builtin; assistant.model = null; assistant.revision++; publish(true)
          completion = await request()
        }
        if (controller.signal.aborted) throw new Error('请求已停止。')
        assistant.text = completion.text; assistant.model = null; assistant.finishReason = completion.finishReason; assistant.status = 'complete'
      } catch (error) {
        assistant.status = controller.signal.aborted ? 'cancelled' : 'error'
        assistant.error = controller.signal.aborted ? '已停止生成，收到的内容已保存。' : attemptSignal.aborted ? '请求超时，已保留收到的内容，请稍后重试。' : this.userError(error, config.token)
      } finally {
        assistant.revision++
        try { publish(true) } catch {
          assistant.status = 'error'; assistant.error = '本地对话保存失败，当前回复仅保留在窗口中。请检查磁盘空间与目录权限。'; assistant.revision++
          this.emit({ type: 'message', message: { ...assistant } })
        } finally { this.runs.delete(id); this.emit({ type: 'conversations' }) }
      }
    }).catch(() => { this.runs.delete(id) }) // A disk failure must not become an unhandled rejection.
    this.emit({ type: 'conversations' })
    return this.view(result)
  }
  async cancel(id: string): Promise<void> {
    const run = this.runs.get(z.string().uuid().parse(id))
    run?.controller.abort('user')
    await run?.task
  }
  async testSettings(raw: unknown): Promise<{ model: string; elapsedMs: number }> {
    if (this.closing) throw new Error('应用正在退出。')
    if (this.tests.size) throw new Error('连接测试正在进行，请稍候。')
    const input = aiSettingsInputSchema.parse(raw), token = this.token(input), started = Date.now()
    // A test always checks and records the candidate itself, never the built-in service.
    this.saveSettings(input)
    const saved = this.store.settings()
    this.store.setVerified(saved.revision, false)
    this.emit({ type: 'settings' })
    const settings = { ...input.settings, stream: false }
    const message: AiMessage = { id: randomUUID(), conversationId: randomUUID(), role: 'user', text: 'Reply with OK.', images: [], status: 'complete', error: null, model: null, createdAt: new Date().toISOString(), revision: 0, finishReason: null }
    const body = buildAiRequest(settings, [message]), controller = new AbortController()
    const timer = setTimeout(() => controller.abort('timeout'), Math.min(settings.timeoutSeconds, 30) * 1000)
    const run: Run = { controller, task: Promise.resolve() }
    const request = requestAiCompletion({ settings, token, body, fetch: this.fetcher, signal: controller.signal, onText: () => undefined })
    run.task = request.then(() => undefined, () => undefined)
    this.tests.add(run)
    try {
      const result = await request
      if (controller.signal.aborted || this.closing) throw new Error('配置检验已停止。')
      if (!this.store.setVerified(saved.revision, true)) throw new Error('配置已更改，请重新检验。')
      this.emit({ type: 'settings' })
      return { model: this.userError(new Error(result.model), token), elapsedMs: Date.now() - started }
    }
    catch (error) { throw new Error(controller.signal.aborted ? '配置检验超时或已停止，请检查地址与网络。' : this.userError(error, token)) }
    finally { clearTimeout(timer); this.tests.delete(run) }
  }
  async shutdown(): Promise<void> {
    this.closing = true
    const runs = [...this.runs.values(), ...this.tests]
    for (const run of runs) run.controller.abort('shutdown')
    await Promise.allSettled(runs.map(run => run.task))
    this.storage?.close(); this.storage = null
  }
}
