import { memo } from 'react'
import { CHORDS, SCALES, materialNotes, mod, noteName, positions, type Position, type Tuning } from './theory.js'
import type { ExerciseConfig, Preferences } from './types.js'
export const Fretboard = memo(function Fretboard({
  tuning,
  preferences,
  active = [],
  onNote
}: {
  tuning: Tuning
  preferences: Preferences
  active?: Position[]
  onNote: (p: Position) => void
}): React.JSX.Element {
  const c = preferences.exercise
  const material = (c.material === 'chord' ? CHORDS[c.chord] : SCALES[c.scale])!
  const chord = CHORDS[c.chord]!
  const spelling = materialNotes(c.root, material)
  const min = c.minFret,
    max = Math.min(c.maxFret, tuning.frets - preferences.capo)
  const columns = max - min + 1,
    width = Math.max(660, columns * 62 + 115),
    height = tuning.notes.length * 43 + 62
  const x = (fret: number) => {
    const offset = ((fret - min + 0.5) * (width - 110)) / columns
    return preferences.leftHanded ? width - 30 - offset : 80 + offset
  }
  const y = (string: number) => 40 + (string - 1) * 43
  const all = positions(tuning, preferences.capo, min, max, c.strings)
  return (
    <div className="ws-fretboard-scroll">
      <svg
        className="ws-fretboard"
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: Math.min(width, 960) }}
        role="group"
        aria-label={`${tuning.name}可视化指板，${min} 至 ${max} 品`}
      >
        <rect x="77" y="19" width={width - 106} height={height - 51} rx="8" fill="var(--fretboard-surface)" />
        {[3, 5, 7, 9, 12, 15, 17, 19, 21, 24]
          .filter((f) => f >= min && f <= max)
          .map((f) => (
            <g key={f}>
              <circle cx={x(f)} cy={height / 2 - 5} r="4" fill="var(--score-muted)" />
              {f % 12 === 0 && <circle cx={x(f)} cy={height / 2 + 12} r="4" fill="var(--score-muted)" />}
            </g>
          ))}
        {Array.from({ length: columns + 1 }, (_, i) => (
          <line
            key={i}
            x1={80 + (i * (width - 110)) / columns}
            x2={80 + (i * (width - 110)) / columns}
            y1="20"
            y2={height - 34}
            stroke={i === (preferences.leftHanded ? columns : 0) && min === 0 ? 'var(--score-ink)' : 'var(--fretboard-line)'}
            strokeWidth={i === (preferences.leftHanded ? columns : 0) && min === 0 ? 4 : 1.5}
          />
        ))}
        {[...tuning.notes].reverse().map((midi, i) => (
          <g key={i}>
            <text x="8" y={y(i + 1) + 4} fill="var(--muted)" fontSize="11">
              {i + 1}
            </text>
            <text x="29" y={y(i + 1) + 4} fill="var(--ink)" fontSize="12">
              {noteName(midi + preferences.capo)}
            </text>
            <line x1="80" x2={width - 30} y1={y(i + 1)} y2={y(i + 1)} stroke="var(--fretboard-line)" strokeWidth={0.9 + i * 0.24} />
          </g>
        ))}
        {Array.from({ length: columns }, (_, i) => (
          <text key={i} x={x(min + i)} y={height - 9} textAnchor="middle" fill="var(--muted)" fontSize="11">
            {min + i === 0 ? '空弦' : min + i}
          </text>
        ))}
        {all.map((p) => {
          const degree = mod(p.midi - c.root),
            index = material.semitones.findIndex((n) => mod(n) === degree),
            isRoot = degree === 0,
            isChord = chord.semitones.some((n) => mod(n) === degree)
          const current = active.some((a) => a.string === p.string && a.fret === p.fret)
          const visible = c.hint === 'all' ? index >= 0 : c.hint === 'roots' ? isRoot : false
          const chordIndex = chord.semitones.findIndex((n) => mod(n) === degree)
          const label =
            preferences.labels === 'degrees'
              ? (material.degrees[index] ?? '')
              : preferences.labels === 'chord'
                ? (chord.degrees[chordIndex] ?? '·')
                : (spelling[index] ?? noteName(p.midi, false))
          return (
            <g
              key={`${p.string}-${p.fret}`}
              role="button"
              tabIndex={0}
              aria-label={`${p.string} 弦 ${p.fret} 品 ${noteName(p.midi)}`}
              onClick={() => onNote(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onNote(p)
                }
              }}
              className="ws-fret-note"
            >
              <title>
                {p.string} 弦 {p.fret} 品 · {noteName(p.midi)}
                {isRoot ? ' · 根音' : ''}
              </title>
              <rect x={x(p.fret) - 23} y={y(p.string) - 20} width="46" height="40" fill="transparent" />
              {visible && (
                <>
                  {isRoot ? (
                    <rect x={x(p.fret) - 15} y={y(p.string) - 15} width="30" height="30" rx="7" fill="var(--accent)" />
                  ) : (
                    <circle
                      cx={x(p.fret)}
                      cy={y(p.string)}
                      r="14"
                      fill={isChord ? 'var(--success)' : 'var(--surface-raised)'}
                      stroke={isChord ? 'var(--success)' : 'var(--border-strong)'}
                    />
                  )}
                  <text
                    x={x(p.fret)}
                    y={y(p.string) + 4}
                    textAnchor="middle"
                    fill={isRoot || isChord ? 'var(--on-accent)' : 'var(--ink)'}
                    fontSize={label.length > 3 ? '10' : '12'}
                    fontWeight="600"
                  >
                    {label}
                  </text>
                </>
              )}
              {current && (c.hint === 'all' || (c.hint === 'roots' && isRoot)) && (
                <circle cx={x(p.fret)} cy={y(p.string)} r="19" fill="none" stroke="var(--danger)" strokeWidth="3" />
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
})
export function ChordDiagram({
  tuning,
  voicing,
  name,
  onNote
}: {
  tuning: Tuning
  voicing: Position[]
  name: string
  onNote: (p: Position) => void
}): React.JSX.Element {
  const stopped = voicing.filter((p) => p.fret > 0),
    base = Math.max(1, Math.min(...stopped.map((p) => p.fret)))
  const min = Number.isFinite(base) ? base : 1
  return (
    <div className="ws-chord-diagram">
      <svg viewBox="0 0 160 180" role="img" aria-label={`${name} 和弦指法`}>
        <text x="80" y="17" textAnchor="middle" fontSize="12" fill="currentColor">
          {name}
        </text>
        {Array.from({ length: 5 }, (_, i) => (
          <line
            key={i}
            x1="30"
            x2="130"
            y1={45 + i * 24}
            y2={45 + i * 24}
            stroke="var(--fretboard-line)"
            strokeWidth={i === 0 && min === 1 ? 3 : 1}
          />
        ))}
        {tuning.notes.map((_, i) => {
          const string = tuning.notes.length - i,
            x = 30 + (i * 100) / (tuning.notes.length - 1),
            pos = voicing.find((p) => p.string === string)
          return (
            <g key={string}>
              <line x1={x} x2={x} y1="45" y2="141" stroke="var(--fretboard-line)" />
              <text x={x} y="35" textAnchor="middle" fontSize="12">
                {!pos ? '×' : pos.fret === 0 ? '○' : ''}
              </text>
              <text x={x} y="161" textAnchor="middle" fontSize="10">
                {string}
              </text>
              {pos && pos.fret > 0 && (
                <circle
                  role="button"
                  tabIndex={0}
                  aria-label={`${string}弦${pos.fret}品`}
                  cx={x}
                  cy={45 + (pos.fret - min + 0.5) * 24}
                  r="8"
                  fill="var(--success)"
                  onClick={() => onNote(pos)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onNote(pos)
                  }}
                />
              )}
            </g>
          )
        })}
        <text x="10" y="62" fontSize="10">
          {min}
        </text>
      </svg>
      <small>
        {voicing
          .slice()
          .sort((a, b) => b.string - a.string)
          .map((p) => noteName(p.midi))
          .join(' · ')}
      </small>
    </div>
  )
}
export function legendLabel(config: ExerciseConfig): string {
  return config.material === 'chord'
    ? '和弦内音程以当前和弦根音为 1'
    : '调内音级以所选主音为 1；和弦音程以所选和弦根音为 1'
}
