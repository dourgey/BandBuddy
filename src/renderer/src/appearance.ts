import { useSyncExternalStore } from 'react'
import { DEFAULT_APPEARANCE, normalizeAppearance, resolveTheme, type Appearance, type AppearanceApi } from '@shared/appearance.js'

const CACHE_KEY = 'bandbuddy.appearance.v1'
let current: Appearance = DEFAULT_APPEARANCE
let theme: 'warm' | 'dark' = 'warm'
let revision = 0
let initialization = 0
let saveGeneration = 0
let unsubscribeApi: (() => void) | undefined
let unsubscribeSystem: (() => void) | undefined
const listeners = new Set<() => void>()
const prefersDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

export function applyAppearance(value: unknown): void {
  revision++
  paintAppearance(value)
}

function paintAppearance(value: unknown): void {
  const next = normalizeAppearance(value)
  const preferencesChanged = next.theme !== current.theme || next.density !== current.density || next.effects !== current.effects
  if (preferencesChanged) current = next
  const resolved = resolveTheme(current, prefersDark?.matches ?? false)
  const themeChanged = theme !== resolved
  theme = resolved
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.themeMode = current.theme
  root.dataset.density = current.density
  root.dataset.effects = current.effects
  root.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(current)) } catch { /* Private mode or full storage must not prevent rendering. */ }
  if (preferencesChanged || themeChanged) {
    listeners.forEach(listener => listener())
    document.dispatchEvent(new CustomEvent('bandbuddy:theme-changed', { detail: theme }))
  }
}

export async function initializeAppearance(api?: Pick<AppearanceApi, 'get' | 'onChanged'>, initialAppearance?: Appearance): Promise<void> {
  const generation = ++initialization
  unsubscribeApi?.()
  unsubscribeSystem?.()
  unsubscribeApi = undefined
  unsubscribeSystem = undefined
  if (initialAppearance) applyAppearance(initialAppearance)
  else { try { applyAppearance(JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')) } catch { applyAppearance(DEFAULT_APPEARANCE) } }
  const changed = (): void => { if (current.theme === 'system') paintAppearance(current) }
  prefersDark?.addEventListener('change', changed)
  unsubscribeSystem = () => prefersDark?.removeEventListener('change', changed)
  if (!api) return
  const initialRevision = revision
  unsubscribeApi = api.onChanged(value => { if (generation === initialization) applyAppearance(value) })
  // Painting cached preferences is immediate; a stalled IPC never holds the app hostage.
  const refresh = api.get().then(value => {
    // A startup response must not undo a later broadcast or a local optimistic edit.
    if (generation === initialization && revision === initialRevision) applyAppearance(value)
  }).catch(() => undefined)
  // Desktop startup already supplied a live, authoritative snapshot. Refresh
  // it in the background instead of inserting another IPC round trip before React.
  if (initialAppearance) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([refresh, new Promise<void>(resolve => { timer = setTimeout(resolve, 350) })])
  clearTimeout(timer)
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) }
export function useAppearance(): Appearance { return useSyncExternalStore(subscribe, () => current) }
export function useResolvedTheme(): 'warm' | 'dark' { return useSyncExternalStore(subscribe, () => theme) }
export function getAppearance(): Appearance { return current }

export async function saveAppearance(value: Appearance): Promise<Appearance> {
  const previous = current
  const generation = ++saveGeneration
  applyAppearance(value)
  const optimisticRevision = revision
  try {
    const saved = window.bandbuddy?.appearance ? await window.bandbuddy.appearance.set(value) : value
    if (generation === saveGeneration && revision === optimisticRevision) applyAppearance(saved)
    return current
  } catch (error) {
    // Other windows remain authoritative if they changed preferences during this request.
    if (generation === saveGeneration && revision === optimisticRevision) applyAppearance(previous)
    throw error
  }
}

/** Canvas/SVG libraries need resolved color values instead of CSS variable expressions. */
export function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
