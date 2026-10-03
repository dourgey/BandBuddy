import { createContext, useContext, useSyncExternalStore, type HTMLAttributes } from 'react'
import type { LessonInstrument } from './lesson-document.js'

const Context = createContext<{ instrument: LessonInstrument; showStaff: boolean } | null>(null)
export const useNotation = () => useContext(Context)
const event = 'bandbuddy-notation-change'
const fallback = new Map<string, boolean>()
const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener(event, notify); window.addEventListener('storage', notify)
  return () => { window.removeEventListener(event, notify); window.removeEventListener('storage', notify) }
}
export function NotationBody({ instrument, children, ...props }: HTMLAttributes<HTMLElement> & { instrument: LessonInstrument }): React.JSX.Element {
  const key = `bandbuddy.notation.staff.${instrument}`
  const showStaff = useSyncExternalStore(subscribe, () => {
    const defaultValue = instrument === 'piano' || instrument === 'keyboard'
    try { const value = localStorage.getItem(key); return value === null ? defaultValue : value === 'true' }
    catch { return fallback.get(key) ?? defaultValue }
  })
  const toggle = (): void => {
    fallback.set(key, !showStaff)
    try { localStorage.setItem(key, String(!showStaff)) } catch { /* Keep the switch usable when storage is unavailable. */ }
    window.dispatchEvent(new Event(event))
  }
  return <Context.Provider value={{ instrument, showStaff }}><article {...props}>
    <div className="ws-notation-toolbar"><button type="button" role="switch" aria-label="显示五线谱" aria-checked={showStaff} onClick={toggle}>
      <span className="ws-notation-switch" aria-hidden="true" />{showStaff ? '隐藏五线谱' : '显示五线谱'}
    </button></div>{children}
  </article></Context.Provider>
}
