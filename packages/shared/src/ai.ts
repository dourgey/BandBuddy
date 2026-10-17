export const AI_CHANNEL = 'ai:request'
export const AI_EVENT = 'ai:changed'
export const AI_MAX_IMAGES = 4
export const AI_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const AI_MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
export const AI_MAX_TEXT = 32_000
export const AI_CONTEXT_TURNS = 20
export const AI_CONTEXT_LENGTH = 32_768

export interface AiSettings {
  baseUrl: string
  model: string
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  tokenLimitField: 'max_tokens' | 'max_completion_tokens'
  presencePenalty: number | null
  frequencyPenalty: number | null
  stream: boolean
  timeoutSeconds: number
  contextTurns: number
  imageDetail: 'auto' | 'low' | 'high'
  extraBody: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  baseUrl: '', model: '', temperature: null, topP: null, maxTokens: null,
  tokenLimitField: 'max_tokens', presencePenalty: null, frequencyPenalty: null,
  stream: true, timeoutSeconds: 120, contextTurns: AI_CONTEXT_TURNS, imageDetail: 'auto', extraBody: '{}'
}

export interface AiSettingsView { settings: AiSettings; hasToken: boolean; verified: boolean }
/** Omit token to preserve it; null removes it. Secrets never appear in settings responses. */
export interface AiSettingsInput { settings: AiSettings; token?: string | null }
export interface AiImage { id: string; name: string; dataUrl: string }
export interface AiMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  text: string
  images: AiImage[]
  status: 'complete' | 'streaming' | 'cancelled' | 'error'
  error: string | null
  model: string | null
  createdAt: string
  revision: number
  finishReason: string | null
}
export interface AiConversationSummary {
  id: string; title: string; preview: string; createdAt: string; updatedAt: string; revision: number
}
export interface AiConversation extends AiConversationSummary { messages: AiMessage[] }
export interface AiSendInput { conversationId: string; text: string; images: AiImage[] }
export type AiEvent = { type: 'message'; message: AiMessage } | { type: 'conversations' } | { type: 'settings' }
export interface AiApi {
  getSettings(): Promise<AiSettingsView>
  saveSettings(input: AiSettingsInput): Promise<AiSettingsView>
  testSettings(input: AiSettingsInput): Promise<{ model: string; elapsedMs: number }>
  list(): Promise<AiConversationSummary[]>
  get(id: string): Promise<AiConversation | null>
  create(): Promise<AiConversation>
  rename(id: string, title: string): Promise<void>
  delete(id: string): Promise<void>
  send(input: AiSendInput): Promise<AiConversation>
  retry(id: string): Promise<AiConversation>
  cancel(id: string): Promise<void>
  onChanged(callback: (event: AiEvent) => void): () => void
}
