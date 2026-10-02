import type { CSSProperties } from 'react'
import { mod, noteName, type Position, type Tuning } from './theory.js'
import { cellId } from './lab-model.js'

export interface LabMarker {
  text: string
  kind: 'root' | 'guide' | 'tone' | 'natural' | 'accidental' | 'ghost' | 'target' | 'correct' | 'wrong'
  mastery?: number | null
}
export function LabBoard({
  tuning,
  min,
  max,
  leftHanded,
  selected,
  marker,
  onClick,
  training = false
}: {
  tuning: Tuning
  min: number
  max: number
  leftHanded: boolean
  selected: string | null
  marker(p: Position): LabMarker | null
  onClick(p: Position): void
  training?: boolean
}): React.JSX.Element {
  const frets = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  if (leftHanded) frets.reverse()
  const strings = tuning.notes.map((midi, index) => ({ midi, string: tuning.notes.length - index })).reverse()
  return (
    <div className="fl-board-scroll" aria-label="主指板">
      <div
        className="fl-board-layout"
        style={
          {
            '--fl-cols': frets.length,
            '--fl-strings': strings.length
          } as CSSProperties
        }
      >
        <div className="fl-string-names">
          {strings.map(({ midi, string }) => (
            <span key={string} title={`第 ${string} 弦 · ${noteName(midi)}`}>
              {noteName(midi, false)}
            </span>
          ))}
        </div>
        <div className={`fl-board ${leftHanded ? 'is-left' : ''}`}>
          <div className="fl-inlays" aria-hidden="true">
            {frets.map((fret) => (
              <div key={fret}>
                {[3, 5, 7, 9, 15, 17, 19, 21].includes(fret) ? (
                  <i />
                ) : fret > 0 && mod(fret) === 0 ? (
                  <>
                    <i />
                    <i />
                  </>
                ) : null}
              </div>
            ))}
          </div>
          {strings.map(({ midi, string }) => (
            <div
              className="fl-string"
              key={string}
              style={
                {
                  '--fl-wire': `${0.8 + (string - 1) * 0.28}px`
                } as CSSProperties
              }
            >
              {frets.map((fret) => {
                const p = { string, fret, midi: midi + fret }
                const mark = marker(p)
                const heat = mark?.mastery
                return (
                  <button
                    key={fret}
                    className={`fl-cell ${fret === 0 ? 'is-open' : ''} ${selected === cellId(p) ? 'is-selected' : ''}`}
                    aria-label={
                      training ? `${string}弦 ${fret}品` : `${string}弦 ${fret}品 ${noteName(p.midi)}`
                    }
                    onClick={() => onClick(p)}
                  >
                    {mark && (
                      <span
                        className={`fl-marker ${mark.kind} ${heat !== undefined ? 'heat' : ''}`}
                        style={
                          heat !== undefined
                            ? {
                                background:
                                  heat === null
                                    ? '#e5e7e4'
                                    : `color-mix(in srgb, #41634d ${Math.round(heat * 100)}%, #e2ebe1)`
                              }
                            : undefined
                        }
                      >
                        {mark.text}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="fl-fret-numbers">
          {frets.map((fret) => (
            <span key={fret}>{fret}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
