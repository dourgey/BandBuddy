import type { CSSProperties } from 'react'
import type { StringPitch } from './poly-pitch.js'
import { noteName } from './theory.js'

const ticks = Array.from({ length: 15 }, (_, index) => index)

export function PolyTunerGauge({ notes, capo, readings }: {
  notes: readonly number[]
  capo: number
  readings: ReadonlyArray<StringPitch | null>
}): React.JSX.Element {
  return <div className="ws-tuner-poly" aria-label="多弦音准">
    <div className="ws-tuner-poly-bank" style={{ '--string-count': notes.length } as CSSProperties}>
      {notes.map((midi, index) => {
        const result = readings[index]
        const cents = result?.cents ?? 0
        const position = 50 + Math.max(-50, Math.min(50, cents))
        const rounded = Math.round(cents)
        const tuned = !!result && Math.abs(cents) <= 3
        const state = !result ? '未检测' : tuned ? '准确' : cents < 0 ? '稍低' : '稍高'
        const note = noteName(midi + capo)
        return <div key={index} role="group" aria-label={`${notes.length - index} 弦 ${note}，${state}`}
          className={`ws-tuner-poly-string ${!result ? 'missing' : tuned ? 'accurate' : 'needs-tuning'}`}>
          <div className="ws-tuner-poly-instrument">
            <span className="ws-tuner-poly-limit">+50</span>
            <div className="ws-tuner-poly-rail" role={result ? 'meter' : undefined}
              aria-label={`${note} 音分偏差`} aria-valuemin={result ? -50 : undefined}
              aria-valuemax={result ? 50 : undefined} aria-valuenow={result ? Math.max(-50, Math.min(50, cents)) : undefined}
              aria-valuetext={result ? `${rounded} 音分，${state}` : undefined}>
              <span className="ws-tuner-poly-zero">0</span>
              <span className="ws-tuner-poly-ticks" aria-hidden="true">{ticks.map((tick) => <i key={tick} />)}</span>
              <span className="ws-tuner-poly-safe-zone" aria-hidden="true" />
              {result && <span className="ws-tuner-poly-travel" aria-hidden="true" style={{
                bottom: `${Math.max(0, position - 20)}%`,
                height: `${Math.min(100, position + 20) - Math.max(0, position - 20)}%`
              }} />}
              {result && <span className="ws-tuner-poly-carriage" aria-hidden="true" style={{ bottom: `${position}%` }}>
                <i className="ws-tuner-poly-indicator" />
              </span>}
            </div>
            <span className="ws-tuner-poly-limit">−50</span>
          </div>
          <b>{note}</b>
          <strong>{result ? `${rounded > 0 ? '+' : ''}${rounded} ¢` : '— ¢'}</strong>
          <small>{state}</small>
        </div>
      })}
      <div className="ws-tuner-poly-glass" aria-hidden="true"><i /><i /></div>
    </div>
    <p><span />快速检查六根弦<span /></p>
  </div>
}
