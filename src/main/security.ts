import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function isTrustedRendererUrl(candidate: string, developmentUrl: string | undefined, rendererFileUrl: string): boolean {
  try {
    const parsed = new URL(candidate)
    if (developmentUrl) {
      const development = new URL(developmentUrl)
      return parsed.protocol === development.protocol && parsed.origin === development.origin
    }
    const expected = new URL(rendererFileUrl)
    if (parsed.protocol !== 'file:' || expected.protocol !== 'file:') return false
    return path.resolve(fileURLToPath(parsed)) === path.resolve(fileURLToPath(expected))
  } catch {
    return false
  }
}
