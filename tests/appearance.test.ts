import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, normalizeAppearance, resolveTheme } from '../packages/shared/src/appearance.js'
import { appearanceSchema } from '../packages/shared/src/appearance-schema.js'

describe('appearance preferences', () => {
  it('repairs missing and invalid fields independently without retaining private settings', () => {
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance('corrupt cache')).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance({ schemaVersion: 7, theme: 'dark', density: 'invalid', effects: 'reduced', libraryRoot: '/private/music', network: { proxyUrl: 'secret' } }))
      .toEqual({ schemaVersion: 1, theme: 'dark', density: 'normal', effects: 'reduced' })
    expect(normalizeAppearance({ theme: 'invalid', density: 'compact' })).toEqual({ ...DEFAULT_APPEARANCE, density: 'compact' })
  })
  it('resolves system mode independently for each device and leaves explicit themes alone', () => {
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'system' }, true)).toBe('dark')
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'system' }, false)).toBe('warm')
    expect(resolveTheme(DEFAULT_APPEARANCE, true)).toBe('warm')
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'dark' }, false)).toBe('dark')
  })
  it('validates IPC changes and strips unrelated fields while defaulting old settings', () => {
    expect(appearanceSchema.parse({})).toEqual(DEFAULT_APPEARANCE)
    expect(appearanceSchema.parse({ theme: 'dark', libraryRoot: '/private' })).toEqual({ ...DEFAULT_APPEARANCE, theme: 'dark' })
    expect(appearanceSchema.safeParse({ theme: 'unknown' }).success).toBe(false)
    expect(appearanceSchema.safeParse({ schemaVersion: 2 }).success).toBe(false)
  })
})
