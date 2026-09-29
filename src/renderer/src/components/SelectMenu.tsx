import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectMenuOption<T extends string | number = number> {
  value: T
  label: string
  disabled?: boolean
}

const OPTION_HEIGHT = 25
const MENU_CHROME = 10

/**
 * Themed replacement for a native <select>: Chromium draws the native popup list with its own
 * widget, which ignores option background/colour, so the list cannot be styled to match the app.
 */
export function SelectMenu<T extends string | number>({ ariaLabel, value, options, disabled = false, menuAnchor = 'trigger', menuClassName, optionHeight = OPTION_HEIGHT, onChange }: {
  ariaLabel: string
  value: T
  options: readonly SelectMenuOption<T>[]
  disabled?: boolean
  menuAnchor?: 'trigger' | 'parent'
  menuClassName?: string
  optionHeight?: number
  onChange(value: T): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const listId = useId()
  const optionId = (index: number): string => `${listId}-option-${index}`
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]

  const openMenu = (): void => {
    const anchor = menuAnchor === 'parent' ? trigger.current?.parentElement : trigger.current
    const bounds = anchor?.getBoundingClientRect()
    if (!bounds) return
    const height = options.length * optionHeight + MENU_CHROME
    const below = window.innerHeight - bounds.bottom - 12
    const above = bounds.top - 12
    const placeAbove = below < height && above > below
    const maxHeight = Math.max(40, Math.min(height, placeAbove ? above : below))
    // The mixer card clips its content, so the menu is placed against the window, not the row.
    setPosition({
      left: Math.min(bounds.left, window.innerWidth - bounds.width - 8),
      top: placeAbove ? bounds.top - maxHeight - 4 : bounds.bottom + 4,
      width: bounds.width,
      maxHeight
    })
    setActiveIndex(selectedIndex)
    setOpen(true)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }

  const commit = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    close(true)
  }

  const moveActive = (step: number): void => {
    let next = activeIndex
    for (let attempt = 0; attempt < options.length; attempt += 1) {
      next = (next + step + options.length) % options.length
      if (!options[next]?.disabled) break
    }
    setActiveIndex(next)
  }

  useEffect(() => {
    if (!open) return
    const dismiss = (): void => close()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (trigger.current?.contains(target) || menu.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open])

  return <>
    <button
      ref={trigger}
      type="button"
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? optionId(activeIndex) : undefined}
      disabled={disabled}
      onClick={() => (open ? close() : openMenu())}
      onKeyDown={(event) => {
        if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault()
          openMenu()
          return
        }
        if (!open) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveActive(event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          setActiveIndex(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          setActiveIndex(options.length - 1)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          commit(activeIndex)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          close(true)
        } else if (event.key === 'Tab') {
          close()
        }
      }}
    >
      <span>{selected?.label ?? ''}</span>
      <ChevronDown size={11} aria-hidden="true" />
    </button>
    {open && createPortal(
      <div
        ref={menu}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        className={`select-menu ${menuClassName ?? ''}`}
        style={{ left: `${position.left}px`, top: `${position.top}px`, minWidth: `${position.width}px`, maxHeight: `${position.maxHeight}px`, overflowY: 'auto' }}
      >
        {options.map((option, index) => <div
          key={option.value}
          id={optionId(index)}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          className={`select-menu-option ${index === activeIndex ? 'is-active' : ''}`}
          onPointerEnter={() => setActiveIndex(index)}
          onClick={() => commit(index)}
        >{option.label}</div>)}
      </div>,
      document.body
    )}
  </>
}
