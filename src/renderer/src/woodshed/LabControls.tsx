import { SelectMenu } from '../components/SelectMenu.js'

export function LabSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: { id: string; name: string }[]
  onChange(value: string): void
}): React.JSX.Element {
  return (
    <SelectMenu
      ariaLabel={label}
      value={Math.max(
        0,
        options.findIndex((o) => o.id === value)
      )}
      options={options.map((o, i) => ({ value: i, label: o.name }))}
      onChange={(index) => {
        if (options[index]) onChange(options[index]!.id)
      }}
    />
  )
}
export function Segments<T extends string | number>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange(value: T): void
}): React.JSX.Element {
  return (
    <div className="fl-segments" role="group" aria-label={label}>
      {options.map(([id, name]) => (
        <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}>
          {name}
        </button>
      ))}
    </div>
  )
}
