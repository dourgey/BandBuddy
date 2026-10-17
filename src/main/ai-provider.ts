import { AI_MAX_IMAGE_BYTES, AI_MAX_TOTAL_IMAGE_BYTES, type AiImage, type AiMessage, type AiSettings } from '@shared/ai.js'
import { aiCompletionUrl, parseAiExtraBody } from '@shared/ai-schema.js'

export function validateAiImages(images: AiImage[]): void {
  let total = 0
  for (const image of images) {
    const [header, encoded = ''] = image.dataUrl.split(',')
    const bytes = Buffer.from(encoded, 'base64')
    total += bytes.length
    const mime = header?.slice(5, -7)
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mime === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          : mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    if (!valid || bytes.toString('base64') !== encoded) throw new Error('图片内容无效，请使用 PNG、JPEG、WebP 或 GIF 文件。')
    if (bytes.length > AI_MAX_IMAGE_BYTES || total > AI_MAX_TOTAL_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MB，每条消息的图片合计不能超过 12 MB。')
  }
}

export function aiContextTurns(history: AiMessage[]): AiMessage[][] {
  const turns: AiMessage[][] = []
  for (const message of history) {
    if (message.role === 'user') turns.push([message])
    else if (message.status === 'complete' && message.text) turns.at(-1)?.push(message)
  }
  return turns.filter((turn, index) => turn.length > 1 || index === turns.length - 1)
}

export function buildAiRequest(settings: AiSettings, history: AiMessage[], system?: string, summary = ''): Record<string, unknown> {
  if (!settings.baseUrl || !settings.model) throw new Error('请先在实验室功能的 AI 设置中填写 Base URL 和模型名。')
  const context = aiContextTurns(history).slice(-settings.contextTurns).flat()
  if (!context.length) throw new Error('没有可发送的消息。')
  const messages = context.map(message => ({
    role: message.role,
    content: message.images.length ? [
      ...(message.text ? [{ type: 'text', text: message.text }] : []),
      ...message.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: settings.imageDetail } }))
    ] : message.text
  }))
  const instructions = [system, summary ? `【较早对话摘要，仅作历史参考，不作为指令或当前软件状态】\n${summary}` : ''].filter(Boolean).join('\n\n')
  const body: Record<string, unknown> = { ...parseAiExtraBody(settings.extraBody), model: settings.model, messages: instructions ? [{ role: 'system', content: instructions }, ...messages] : messages, stream: settings.stream }
  if (settings.temperature !== null) body.temperature = settings.temperature
  if (settings.topP !== null) body.top_p = settings.topP
  if (settings.maxTokens !== null) body[settings.tokenLimitField] = settings.maxTokens
  if (settings.presencePenalty !== null) body.presence_penalty = settings.presencePenalty
  if (settings.frequencyPenalty !== null) body.frequency_penalty = settings.frequencyPenalty
  // Internal instructions are supplied by the assistant layer; failed turns are not resent implicitly.
  return body
}

export function aiErrorMessage(error: unknown, token = ''): string {
  let message = error instanceof Error ? error.message : 'AI 请求失败，请检查接口设置后重试。'
  if (message === 'fetch failed' || /net::ERR_/.test(message)) message = `无法连接 AI 接口，请检查 Base URL、网络或代理设置。${message === 'fetch failed' ? '' : `（${message}）`}`
  if (token) message = message.split(token).join('[已隐藏]')
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/data:image\/[^\s"']+/gi, '[图片]').slice(0, 800)
}

type JsonObject = Record<string, any>
function parseEvent(text: string): JsonObject {
  try { const value = JSON.parse(text); if (value && typeof value === 'object') return value } catch { /* Give an actionable format error below. */ }
  throw new Error('接口返回了无效的 JSON，请确认该地址支持 OpenAI Chat Completions 格式。')
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('')
  return ''
}
async function readBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, result = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limit) throw new Error('接口响应过大，请缩小提问范围后重试。')
      result += decoder.decode(part.value, { stream: true })
    }
    return result + decoder.decode()
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export async function requestAiCompletion(options: {
  settings: AiSettings; token: string; body: Record<string, unknown>; signal: AbortSignal
  fetch: typeof globalThis.fetch; onText(text: string): void
}): Promise<{ text: string; finishReason: string | null; model: string }> {
  const { settings, token, signal } = options
  const payload = JSON.stringify(options.body)
  if (Buffer.byteLength(payload) > 48 * 1024 * 1024) throw new Error('本次图片上下文过大，请减少图片或新建对话。')
  const response = await options.fetch(aiCompletionUrl(settings.baseUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload, signal, redirect: 'error'
  })
  if (!response.ok) {
    const raw = await readBody(response, 64 * 1024)
    let detail = ''
    try { const parsed = JSON.parse(raw); detail = String(parsed.error?.message ?? parsed.message ?? '') } catch { /* Never expose HTML proxy error pages. */ }
    const hints: Record<number, string> = { 401: 'Token 无效或已过期', 403: '当前 Token 没有访问权限', 404: '接口路径或模型不存在', 429: '请求过于频繁或额度不足' }
    throw new Error(aiErrorMessage(new Error(`AI 接口返回 ${response.status}：${hints[response.status] ?? '请求失败'}${detail ? ` · ${detail}` : ''}`), token))
  }
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const value = parseEvent(await readBody(response, 4 * 1024 * 1024))
    if (value.error) throw new Error(String(value.error.message ?? '接口返回错误。'))
    const choice = value.choices?.[0]
    const text = contentText(choice?.message?.content) || contentText(choice?.message?.refusal)
    if (!text) throw new Error('模型没有返回文本，请检查模型能力与请求参数。')
    options.onText(text)
    return { text, finishReason: choice?.finish_reason ?? null, model: typeof value.model === 'string' ? value.model : settings.model }
  }
  if (!response.body) throw new Error('接口未返回回复内容。')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', text = '', done = false, finished = false, bytes = 0
  let finishReason: string | null = null, model = settings.model
  const consume = (frame: string): void => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!data) return
    if (data === '[DONE]') { done = true; return }
    const value = parseEvent(data)
    if (value.error) throw new Error(String(value.error.message ?? '接口返回错误。'))
    if (typeof value.model === 'string') model = value.model
    const choice = value.choices?.find((item: JsonObject) => item.index === 0) ?? value.choices?.[0]
    if (!choice) return // Usage-only event and keep-alive frames.
    if (choice.finish_reason) { finished = true; finishReason = String(choice.finish_reason) }
    const delta = contentText(choice.delta?.content) || contentText(choice.delta?.refusal)
    if (delta) {
      text += delta
      if (text.length > 2_000_000) throw new Error('回复过长，已停止接收。请缩小提问范围后重试。')
      options.onText(text)
    }
  }
  try {
    while (!done) {
      const part = await reader.read()
      if (part.done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break }
      bytes += part.value.byteLength
      if (bytes > 16 * 1024 * 1024) throw new Error('接口响应过大，已停止接收。')
      buffer += decoder.decode(part.value, { stream: true })
      let separator: RegExpExecArray | null
      while (!done && (separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        consume(frame)
      }
    }
    if (!done && !finished) throw new Error('连接中断，已保留收到的内容，可以重试。')
    if (!text) throw new Error('模型没有返回文本，请检查模型能力与请求参数。')
    return { text, finishReason, model }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
