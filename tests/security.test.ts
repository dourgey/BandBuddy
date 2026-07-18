import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isManagedPath } from '../src/main/path-safety.js'
import { isTrustedRendererUrl } from '../src/main/security.js'

describe('path and renderer origin constraints', () => {
  it('rejects path traversal and prefix lookalikes', () => {
    const root = path.resolve('C:/Users/Test/Music/BandBuddy')
    expect(isManagedPath(root, path.join(root, 'song-id', 'vocals.flac'))).toBe(true)
    expect(isManagedPath(root, path.resolve(root, '..', 'BandBuddy-evil', 'file'))).toBe(false)
  })

  it('requires the exact dev origin or production file', () => {
    const renderer = pathToFileURL(path.resolve('out/renderer/index.html')).href
    expect(isTrustedRendererUrl('http://localhost:5173/practice', 'http://localhost:5173/', renderer)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173.evil.test/', 'http://localhost:5173/', renderer)).toBe(false)
    expect(isTrustedRendererUrl(renderer, undefined, renderer)).toBe(true)
    expect(isTrustedRendererUrl(pathToFileURL(path.resolve('out/renderer/other.html')).href, undefined, renderer)).toBe(false)
  })
})
