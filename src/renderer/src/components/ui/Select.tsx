import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

interface Option { value: string; label: ReactNode; text: string; disabled: boolean }
const textOf = (value: ReactNode): string => Children.toArray(value).map(child => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : String(child)).join('')
function optionsOf(children: ReactNode, groupDisabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)) return []
    if (child.type === Fragment || child.type === 'optgroup') return optionsOf(child.props.children, groupDisabled || Boolean(child.props.disabled))
    if (child.type !== 'option') return []
    const text = textOf(child.props.children)
    return [{ value: String(child.props.value ?? text), label: child.props.children, text, disabled: groupDisabled || Boolean(child.props.disabled) }]
  })
}

/** The native element only carries form/change semantics; the visible control is themed. */
export function Select({ children, className = '', style, id, value, defaultValue, onChange, disabled, title, ...props }: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  const generatedId = useId()
  const listId = `${generatedId}-options`
  const native = useRef<HTMLSelectElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const options = optionsOf(children)
  const [internal, setInternal] = useState(String(defaultValue ?? options[0]?.value ?? ''))
  const selectedValue = String(value ?? internal)
  const selected = options.find(option => option.value === selectedValue)
  const [open, setOpen] = useState(false)
  const [implicitLabel, setImplicitLabel] = useState<string>()
  const [active, setActive] = useState(0)
  const [anchor, setAnchor] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 })
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  const search = useRef({ value: '', at: 0 })
  const enabledIndexes = options.flatMap((option, index) => option.disabled ? [] : [index])

  const close = (focus = true): void => { setOpen(false); if (focus) trigger.current?.focus() }
  const show = (): void => {
    if (disabled || !trigger.current) return
    // Preserve the modal focus scope; the popover top layer escapes clipping and transforms.
    setPortal(trigger.current.closest<HTMLElement>('[role="dialog"]') ?? document.body)
    const index = options.findIndex(option => option.value === selectedValue && !option.disabled)
    setActive(index >= 0 ? index : enabledIndexes[0] ?? -1)
    setOpen(true)
  }
  const commit = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled || !native.current) return
    setInternal(option.value)
    native.current.value = option.value
    native.current.dispatchEvent(new Event('change', { bubbles: true }))
    close()
  }
  const move = (direction: number): void => {
    if (!enabledIndexes.length) return
    const index = enabledIndexes.indexOf(active)
    setActive(enabledIndexes[(index + direction + enabledIndexes.length) % enabledIndexes.length]!)
  }
  useLayoutEffect(() => {
    if (props['aria-label'] || props['aria-labelledby']) return
    const label = trigger.current?.closest('label')
    if (!label) return
    const text = Array.from(label.childNodes).filter(node => !node.contains(trigger.current)).map(node => node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim()
    if (text) setImplicitLabel(text)
  }, [props['aria-label'], props['aria-labelledby']])
  useEffect(() => {
    if (value !== undefined) return
    const form = native.current?.form
    const reset = (): void => { queueMicrotask(() => { if (native.current) setInternal(native.current.value) }) }
    form?.addEventListener('reset', reset)
    return () => form?.removeEventListener('reset', reset)
  }, [value])
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    list.current?.showPopover?.()
    const bounds = trigger.current.getBoundingClientRect()
    const width = Math.min(Math.max(bounds.width, 180), window.innerWidth - 16)
    const below = window.innerHeight - bounds.bottom - 12
    const above = bounds.top - 12
    const height = Math.min(288, Math.max(below, above), options.length * 36 + 8)
    setAnchor({ left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)), top: below >= Math.min(288, options.length * 36 + 8) || below >= above ? bounds.bottom + 4 : bounds.top - height - 4, width, maxHeight: Math.max(36, height) })
  }, [open, options.length])
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!trigger.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) close(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    window.addEventListener('keydown', escape, true)
    const resize = (): void => close(false)
    const scroll = (event: Event): void => { if (!list.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('keydown', escape, true); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  return <span className={`bb-select ${className}`} style={style}>
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={props['aria-label'] ?? implicitLabel} aria-labelledby={props['aria-labelledby']} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']} aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined} aria-haspopup="listbox" disabled={disabled} title={title ?? selected?.text} className="bb-select-trigger" onClick={() => open ? close() : show()} onKeyDown={event => {
      if (event.key === 'Escape' && !open) return
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { close(); return }
        if (!open) { show(); return }
        if (event.key === 'ArrowDown') move(1)
        else if (event.key === 'ArrowUp') move(-1)
        else if (event.key === 'Home') setActive(enabledIndexes[0] ?? -1)
        else if (event.key === 'End') setActive(enabledIndexes.at(-1) ?? -1)
        else commit(active)
      } else if (event.key === 'Tab') close(false)
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now()
        search.current = { value: (now - search.current.at < 700 ? search.current.value : '') + event.key.toLocaleLowerCase(), at: now }
        const index = options.findIndex(option => !option.disabled && option.text.toLocaleLowerCase().startsWith(search.current.value))
        if (!open) show()
        if (index >= 0) setActive(index)
      }
    }}><span>{selected?.label ?? options[0]?.label ?? '请选择'}</span><ChevronDown size={14} aria-hidden="true" /></button>
    <select {...props} ref={native} value={value} defaultValue={defaultValue} disabled={disabled} onChange={onChange} aria-label={undefined} aria-labelledby={undefined} aria-hidden="true" tabIndex={-1} className="bb-select-native">{children}</select>
    {open && portal && createPortal(<div ref={list} popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined} id={listId} role="listbox" aria-label={props['aria-label'] ?? implicitLabel} className="bb-select-popup" style={anchor}>
      {options.length ? options.map((option, index) => <div key={`${option.value}-${index}`} id={`${listId}-${index}`} data-option-index={index} role="option" aria-selected={option.value === selectedValue} aria-disabled={option.disabled || undefined} className={`bb-select-option ${active === index ? 'is-active' : ''}`} onPointerMove={() => { if (!option.disabled) setActive(index) }} onPointerDown={event => event.preventDefault()} onClick={() => commit(index)}><span>{option.label}</span>{option.value === selectedValue && <Check size={14} aria-hidden="true" />}</div>) : <div className="bb-select-empty">暂无可选项</div>}
    </div>, portal)}
  </span>
}
