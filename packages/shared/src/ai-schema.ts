import { z } from 'zod'
import { AI_MAX_IMAGES, AI_MAX_IMAGE_BYTES, AI_MAX_TEXT, DEFAULT_AI_SETTINGS } from './ai.js'

export function aiCompletionUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请填写有效的 AI Base URL。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 仅支持 HTTP/HTTPS，不能包含账号、查询参数或锚点。')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/chat/completions') ? path : `${path || '/v1'}/chat/completions`
  return url.toString()
}

const reserved = new Set(['model', 'messages', 'stream', 'n', 'tools', 'tool_choice', 'functions', 'function_call', 'modalities', 'audio', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', '__proto__', 'constructor', 'prototype'])
export function parseAiExtraBody(value: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(value.trim() || '{}') } catch { throw new Error('额外请求参数必须是有效的 JSON 对象。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('额外请求参数必须是 JSON 对象。')
  if (Object.keys(parsed).some(key => reserved.has(key))) throw new Error('额外参数不能覆盖模型、消息、生成参数或启用工具调用。')
  return parsed as Record<string, unknown>
}

export const aiSettingsSchema = z.object({
  baseUrl: z.string().trim().max(2048).refine(value => { try { if (value) aiCompletionUrl(value); return true } catch { return false } }, 'Base URL 格式不正确'),
  model: z.string().trim().max(200),
  temperature: z.number().finite().min(0).max(2).nullable(),
  topP: z.number().finite().min(0).max(1).nullable(),
  maxTokens: z.number().int().min(1).max(1_048_576).nullable(),
  tokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']),
  presencePenalty: z.number().finite().min(-2).max(2).nullable(),
  frequencyPenalty: z.number().finite().min(-2).max(2).nullable(),
  stream: z.boolean(),
  timeoutSeconds: z.number().int().min(5).max(1800),
  contextTurns: z.number().int().min(1).max(100),
  imageDetail: z.enum(['auto', 'low', 'high']),
  extraBody: z.string().max(16_384).refine(value => { try { parseAiExtraBody(value); return true } catch { return false } }, '额外参数必须是 JSON 对象，且不能覆盖已有字段或启用工具调用')
})
// Only connection fields are user configurable. Ignore legacy advanced values on read/save.
export const aiConnectionSettingsSchema = aiSettingsSchema.pick({ baseUrl: true, model: true })
  .transform(value => ({ ...DEFAULT_AI_SETTINGS, ...value }))
export const aiSettingsInputSchema = z.object({ settings: aiConnectionSettingsSchema, token: z.string().trim().min(1).max(8192).refine(value => !/[\r\n]/.test(value)).nullable().optional() })
export const aiImageSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(255),
  dataUrl: z.string().max(Math.ceil(AI_MAX_IMAGE_BYTES / 3) * 4 + 64).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/)
})
export const aiSendSchema = z.object({ conversationId: z.string().uuid(), text: z.string().trim().max(AI_MAX_TEXT), images: z.array(aiImageSchema).max(AI_MAX_IMAGES) })
  .refine(value => !!value.text || value.images.length > 0, '请输入消息或添加图片。')
