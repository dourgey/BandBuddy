import { createContext, useCallback, useContext, useEffect, useId, useState, useSyncExternalStore, type HTMLAttributes } from 'react'
import type { LessonInstrument } from './lesson-document.js'

const Context = createContext<{ instrument: LessonInstrument; showStaff: boolean; register: (id: string, alternative?: boolean) => void } | null>(null)
export const useNotation = () => useContext(Context)
export function useNotationCapability(alternative: boolean): void {
  const register = useContext(Context)?.register
  const id = useId()
  useEffect(() => {
    register?.(id, alternative)
    return () => register?.(id)
  }, [id, register, alternative])
}
const event = 'bandbuddy-notation-change'
const fallback = new Map<string, boolean>()
const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener(event, notify); window.addEventListener('storage', notify)
  return () => { window.removeEventListener(event, notify); window.removeEventListener('storage', notify) }
}
export function NotationBody({ instrument, children, ...props }: HTMLAttributes<HTMLElement> & { instrument: LessonInstrument }): React.JSX.Element {
  const key = `bandbuddy.notation.staff.${instrument}`
  const [capabilities, setCapabilities] = useState(new Map<string, boolean>())
  const register = useCallback((id: string, alternative?: boolean): void => {
    setCapabilities(current => {
      if (alternative === undefined ? !current.has(id) : current.get(id) === alternative) return current
      const next = new Map(current)
      if (alternative === undefined) next.delete(id); else next.set(id, alternative)
      return next
    })
  }, [])
  const staffOnly = instrument === 'drums' || (capabilities.size > 0 && [...capabilities.values()].every(alternative => !alternative))
  const preference = useSyncExternalStore(subscribe, () => {
    const defaultValue = instrument === 'piano' || instrument === 'keyboard'
    try { const value = localStorage.getItem(key); return value === null ? defaultValue : value === 'true' }
    catch { return fallback.get(key) ?? defaultValue }
  })
  const showStaff = staffOnly || preference
  const toggle = (): void => {
    if (staffOnly) return
    fallback.set(key, !showStaff)
    try { localStorage.setItem(key, String(!showStaff)) } catch { /* Keep the switch usable when storage is unavailable. */ }
    window.dispatchEvent(new Event(event))
  }
  return <Context.Provider value={{ instrument, showStaff, register }}><article {...props}>
    <div className="ws-notation-toolbar"><button type="button" role="switch" aria-label="显示五线谱" aria-checked={showStaff} disabled={staffOnly} title={staffOnly ? '本章只有五线谱，保持显示' : undefined} onClick={toggle}>
      <span className="ws-notation-switch" aria-hidden="true" />显示五线谱
    </button></div>{children}
  </article></Context.Provider>
}
