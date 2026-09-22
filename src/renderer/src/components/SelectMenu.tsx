import { Select } from './ui/Select.js'

export interface SelectMenuOption { value: number; label: string; disabled?: boolean }

/** Numeric mixer adapter over the same accessible control used throughout the app. */
export function SelectMenu({ ariaLabel, value, options, disabled = false, onChange }: {
  ariaLabel: string
  value: number
  options: readonly SelectMenuOption[]
  disabled?: boolean
  onChange(value: number): void
}): React.JSX.Element {
  return <Select aria-label={ariaLabel} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </Select>
}
