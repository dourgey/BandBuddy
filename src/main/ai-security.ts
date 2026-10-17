const HIDDEN = '[密钥已隐藏]'
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const variants = (secrets: readonly string[]): string[] => [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex')]))]

/** Apply before model context, persistence, IPC events and copying. Never log the raw input. */
export function redactAiSecrets(text: string, secrets: readonly string[] = []): string {
  let safe = text
  for (const secret of variants(secrets).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join(HIDDEN)
  return safe.replace(/\b(?:sk|rk)-[a-z0-9_-]*/gi, HIDDEN)
    .replace(/Bearer\s+[^\s"'<>]+/gi, `Bearer ${HIDDEN}`)
    .replace(/((?:api[_ -]?key|token|secret|authorization|password|密钥|秘钥)["'\s]*[:=：]["'\s]*)[^\s,"'}<>]+/gi, `$1${HIDDEN}`)
}

/** Cumulative SSE text: hold possible secret prefixes until they can be safely replaced. */
export function guardAiReply(text: string, secrets: readonly string[], models: readonly string[], final = false): string {
  let source = text
  if (!final) {
    let held = 0
    for (const secret of [...variants(secrets), 'sk-', 'rk-', 'Bearer ']) {
      for (let length = 1; length < secret.length && length <= source.length; length++) {
        if (source.endsWith(secret.slice(0, length))) held = Math.max(held, length)
      }
    }
    if (held) source = source.slice(0, -held)
    // Keep an unfinished self-introduction off screen until its identity can be checked.
    source = source.replace(/(?:我是|我来自|我是由|我由|作为|I am\b|I'm\b)[^。！？!\n]*$/i, '')
  }
  if (final) {
    for (const secret of variants(secrets)) {
      for (let length = secret.length - 1; length >= 4; length--) {
        if (source.endsWith(secret.slice(0, length))) { source = source.slice(0, -length) + HIDDEN; break }
      }
    }
  }
  let safe = redactAiSecrets(source, secrets)
  const identities = [...models, 'Qwen', '通义', '千问', '阿里', 'OpenAI', 'ChatGPT', 'GPT-', 'DeepSeek', '深度求索', 'Claude', 'Anthropic', 'Gemini', 'Google', '谷歌', 'SiliconFlow', '硅基流动'].filter(Boolean).map(escape).join('|')
  safe = safe.replace(new RegExp(`(?:我是|我来自|我是由|我由|作为|I am\\b|I'm\\b)[^。！？!\\n]{0,120}(?:${identities})[^。！？!\\n]*`, 'gi'), '我是邦邦，陪你玩音乐的小伙伴♪')
  return safe
}
