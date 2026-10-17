import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/ai.js'

export interface AiProviderConfig { settings: AiSettings; token: string }

// Main-process only. Never include this configuration in renderer settings or diagnostics.
export const BUILTIN_AI_CONFIG: AiProviderConfig = {
  settings: { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3.5-4B', extraBody: '{"enable_thinking":false}' },
  token: process.env.BANDBUDDY_AI_TOKEN?.trim() ?? ''
}
