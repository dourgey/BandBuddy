/** Dependency-free preferences are safe to read before the first renderer paint. */
export interface Appearance {
  schemaVersion: 1
  theme: 'warm' | 'dark' | 'system'
  density: 'normal' | 'compact'
  effects: 'standard' | 'reduced'
}
export type ResolvedTheme = 'warm' | 'dark'
export const DEFAULT_APPEARANCE: Appearance = Object.freeze({ schemaVersion: 1, theme: 'warm', density: 'normal', effects: 'standard' })

/** Repair individual preferences without discarding other valid settings. */
export function normalizeAppearance(value: unknown): Appearance {
  const raw = value && typeof value === 'object' ? value as Partial<Appearance> : {}
  return {
    schemaVersion: 1,
    theme: ['warm', 'dark', 'system'].includes(raw.theme ?? '') ? raw.theme! : 'warm',
    density: raw.density === 'compact' ? 'compact' : 'normal',
    effects: raw.effects === 'reduced' ? 'reduced' : 'standard'
  }
}

export function resolveTheme(appearance: Appearance, prefersDark: boolean): ResolvedTheme {
  return appearance.theme === 'system' ? prefersDark ? 'dark' : 'warm' : appearance.theme
}

export function themeBackground(theme: ResolvedTheme): string {
  return theme === 'dark' ? '#191816' : '#f5f1ea'
}

export interface AppearanceApi {
  get(): Promise<Appearance>
  set(appearance: Appearance): Promise<Appearance>
  onChanged(callback: (appearance: Appearance) => void): () => void
}
