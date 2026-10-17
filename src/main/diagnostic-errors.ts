import os from 'node:os'
import type { ErrorEvidence, EnvironmentComponent } from '@shared/environment.js'

/** The original error survives every boundary; classification never replaces it. */
export class DiagnosticError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause }); this.name = 'DiagnosticError'
  }
}

export function errorEvidence(error: unknown, depth = 0, seen = new Set<unknown>()): ErrorEvidence {
  if (depth > 5 || seen.has(error)) return { name: 'Truncated', code: 'CAUSE_TRUNCATED', message: '原因链已截断' }
  seen.add(error)
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(value.message ?? error)
  const code = typeof value.code === 'string' ? value.code : /^(?:Error:\s*)?([A-Z][A-Z0-9_]+)(?=:|\s|$)/.exec(message)?.[1] ?? 'UNKNOWN_ERROR'
  const causes = error instanceof AggregateError ? [...error.errors] : value.cause !== undefined ? [value.cause] : Array.isArray(value.causes) ? value.causes : []
  const details = { ...(typeof value.details === 'object' && value.details !== null ? value.details : {}),
    ...Object.fromEntries(['errno', 'syscall', 'path', 'signal', 'exitCode'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) }
  return { name: error instanceof Error ? error.name : String(value.name ?? 'Error'), code, message: message.slice(-16_384),
    ...(typeof value.stack === 'string' ? { stack: value.stack.slice(-16_384) } : {}),
    ...(Object.keys(details).length ? { details } : {}),
    ...(causes.length ? { causes: causes.slice(0, 12).map(cause => errorEvidence(cause, depth + 1, seen)) } : {}) }
}
export function evidenceText(error: unknown): string {
  const evidence = errorEvidence(error)
  return JSON.stringify(evidence)
}
export function primaryErrorCode(error: unknown): string { return errorEvidence(error).code }

const privateRoots = new Set<string>([os.homedir()])
export function registerDiagnosticRoots(roots: string[]): void { roots.filter(Boolean).forEach(root => privateRoots.add(root)) }
export function redactDiagnostics(value: unknown, additionalRoots: string[] = []): string {
  const roots = [...privateRoots, ...additionalRoots].filter(Boolean).sort((a, b) => b.length - a.length)
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (key, nested: unknown) => {
    if (/password|token|secret|authorization|proxyUrl|cookie/i.test(key)) return '<redacted>'
    if (nested instanceof Error) return errorEvidence(nested)
    if (nested && typeof nested === 'object') {
      if (seen.has(nested)) return '<repeated>'
      seen.add(nested)
    }
    if (typeof nested !== 'string') return nested
    let text = nested
    for (const root of roots) {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[/\\]/g, '[/\\\\]')
      text = text.replace(new RegExp(escaped, 'gi'), '<local-path>')
    }
    return text.replace(/https?:[^\s"<>]+/gi, raw => {
      try { const url = new URL(raw); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/<redacted>` } catch { return '<url>' }
    }).replace(/\b[A-Z]:[\\/][^\r\n"<>]*/gi, '<local-path>')
      .replace(/\/(?:Users|home|Volumes)\/[^\s"<>]*/g, '<local-path>')
      .replace(/((?:password|token|secret|authorization|cookie)["'\s]*[:=]["'\s]*)[^,\s"'}]+/gi, '$1<redacted>')
  }, 2)
}
export function componentForStage(stage: string): EnvironmentComponent {
  if (/model/i.test(stage)) return 'models'
  if (/python|venv|interpreter/i.test(stage)) return 'python'
  if (/wheel|dependencies|imports/i.test(stage)) return 'dependencies'
  if (/cuda|gpu|compute|inference|probe/i.test(stage)) return 'compute'
  if (/vc|prerequisite|system/i.test(stage)) return 'system-runtime'
  return 'task'
}
