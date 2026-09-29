import { useEffect, useRef, useState } from 'react'
import { Settings2, X, Play } from 'lucide-react'
import { TUNINGS, noteName, mod } from './theory.js'
import { instrumentNames, type HarmonyInstrument } from './harmony.js'

export interface InstrumentConfig { tuning: string; frets: number; leftHanded: boolean; octave: number; labels: boolean }
export const DEFAULT_CONFIGS: Record<HarmonyInstrument, InstrumentConfig> = {
  guitar: { tuning: 'guitar', frets: 12, leftHanded: false, octave: 3, labels: true },
  bass: { tuning: 'bass', frets: 15, leftHanded: false, octave: 2, labels: true },
  ukulele: { tuning: 'uke-high', frets: 12, leftHanded: false, octave: 3, labels: true },
  piano: { tuning: '', frets: 12, leftHanded: false, octave: 3, labels: true }
}
const extraTunings = [
  { id: 'd-standard', name: 'D Standard', instrument: 'guitar', notes: [38,43,48,53,57,62] },
  { id: 'open-g', name: 'Open G', instrument: 'guitar', notes: [38,43,50,55,59,62] },
  { id: 'open-d', name: 'Open D', instrument: 'guitar', notes: [38,45,50,54,57,62] }
]
interface MappingProps {
  instrument: HarmonyInstrument; config: InstrumentConfig; onConfig: (config: InstrumentConfig) => void
  labels: Map<number, {note: string; degree: string}>; chordPcs: number[]; root: number; degree: boolean
  selected: number | null; keyTitle: string; onNote: (midi: number) => void
}
export function HarmonyInstrumentView(props: MappingProps): React.JSX.Element {
  const { instrument, config, onConfig, labels, chordPcs, root, degree, selected, keyTitle, onNote } = props
  const [settings, setSettings] = useState(false)
  const [info, setInfo] = useState<{ midi: number; string?: number; fret?: number } | null>(null)
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current) }, [])
  const patch = (value: Partial<InstrumentConfig>): void => onConfig({ ...config, ...value })
  const tunings = [...TUNINGS, ...extraTunings].filter(t => t.instrument === instrument)
  const tuning = tunings.find(t => t.id === config.tuning) ?? tunings[0]
  const color = (midi: number): string => {
    const pc = mod(midi)
    return `${pc === root ? 'root' : chordPcs.includes(pc) ? 'chord' : labels.has(pc) ? 'scale' : 'other'} ${selected === pc ? 'selected' : ''}`
  }
  const label = (midi: number): string => degree ? labels.get(mod(midi))?.degree ?? '·' : labels.get(mod(midi))?.note ?? noteName(midi, false)
  const noteProps = (midi: number, string?: number, fret?: number) => ({
    onClick: () => onNote(midi),
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setInfo({ midi, string, fret }) },
    onPointerDown: () => { if (longPress.current) clearTimeout(longPress.current); longPress.current = setTimeout(() => { setInfo({ midi, string, fret }); longPress.current = null }, 550) },
    onPointerUp: () => { if (longPress.current) clearTimeout(longPress.current) },
    onPointerLeave: () => { if (longPress.current) clearTimeout(longPress.current) },
    onPointerCancel: () => { if (longPress.current) clearTimeout(longPress.current) }
  })
  const startMidi = (config.octave + 1) * 12
  const keys = Array.from({ length: 37 }, (_, i) => startMidi + i)
  const whiteKeys = keys.filter(n => [0,2,4,5,7,9,11].includes(mod(n)))
  return <section className={`he-instrument he-${instrument}`} aria-label={`${instrumentNames[instrument]} 映射`}>
    <header><h3>{instrumentNames[instrument]}</h3><button className="he-icon" aria-label={`${instrumentNames[instrument]} 设置`} aria-expanded={settings} onClick={() => setSettings(!settings)}><Settings2 size={16} /></button>
      {instrument === 'piano' ? <select aria-label="钢琴音域" value={config.octave} onChange={e => patch({ octave: Number(e.target.value) })}>{[2,3,4].map(o => <option key={o} value={o}>C{o} – C{o+3}</option>)}</select> : <><select aria-label={`${instrumentNames[instrument]} 调弦`} value={config.tuning} onChange={e => patch({ tuning: e.target.value })}>{tunings.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><span className="he-strings-count">{tuning!.notes.length} Strings</span><select aria-label={`${instrumentNames[instrument]} 品位范围`} value={config.frets} onChange={e => patch({ frets: Number(e.target.value) })}>{[12,15,24].map(f => <option key={f} value={f}>0 – {f} Frets</option>)}</select></>}
    </header>
    {settings && <div className="he-instrument-settings">{instrument === 'piano' ? <label><input type="checkbox" checked={config.labels} onChange={e => patch({ labels: e.target.checked })} /> 显示琴键标签</label> : <label><input type="checkbox" checked={config.leftHanded} onChange={e => patch({ leftHanded: e.target.checked })} /> 左手指板</label>}<span>右键或长按音位查看详情</span></div>}
    {instrument === 'piano' ? <div className="he-piano-scroll"><div className="he-keyboard">
      {whiteKeys.map(midi => <button key={midi} aria-label={`${instrumentNames[instrument]} ${noteName(midi)}`} className={`he-white-key ${color(midi)}`} {...noteProps(midi)}><span>{config.labels ? label(midi) : ''}</span></button>)}
      {keys.filter(n => !whiteKeys.includes(n)).map(midi => <button key={midi} aria-label={`${instrumentNames[instrument]} ${noteName(midi)}`} className={`he-black-key ${color(midi)}`} style={{ left: `${(whiteKeys.filter(n => n < midi).length - .32) / whiteKeys.length * 100}%`, width: `${.64 / whiteKeys.length * 100}%` }} {...noteProps(midi)}><span>{config.labels ? label(midi) : ''}</span></button>)}
    </div><div className="he-octaves">{[0,1,2,3].map(n => <span key={n}>C{config.octave+n}</span>)}</div></div> : <div className="he-fret-scroll"><div className={`he-fretboard-wrap ${config.leftHanded ? 'left-handed' : ''}`} style={{ minWidth: config.frets > 15 ? 820 : 490 }}>
      <div className="he-string-labels">{[...tuning!.notes].reverse().map((midi,i) => <b key={i}>{noteName(midi,false)}</b>)}</div>
      <div className="he-neck" style={{ gridTemplateRows: `repeat(${tuning!.notes.length}, 1fr)` }}>
        {[...tuning!.notes].reverse().map((open, row) => <div className="he-string" key={row} style={{ gridTemplateColumns: `repeat(${config.frets+1}, 1fr)`, '--string-weight': `${.6 + row * .27}px` } as React.CSSProperties}>
          {Array.from({ length: config.frets+1 }, (_, fret) => <div key={fret} className={`he-fret ${fret === 0 ? 'open' : ''}`}><button aria-label={`${instrumentNames[instrument]} ${row+1}弦 ${fret}品 ${noteName(open+fret)}`} className={`he-note ${color(open+fret)}`} {...noteProps(open+fret,row+1,fret)}>{label(open+fret)}</button>{row === Math.floor(tuning!.notes.length/2) && [3,5,7,9,12,15,17,19,21,24].includes(fret) && <i className="he-inlay">{fret % 12 === 0 ? '••' : '•'}</i>}</div>)}
        </div>)}
      </div><div className="he-fret-numbers" style={{ gridTemplateColumns: `repeat(${config.frets+1}, 1fr)` }}>{Array.from({ length: config.frets+1 }, (_, f) => <span key={f}>{f}</span>)}</div>
    </div></div>}
    {info && <div className="he-note-info" role="dialog" aria-label="音位详情"><button className="he-icon" aria-label="关闭音位详情" onClick={() => setInfo(null)}><X size={15} /></button><strong>{labels.get(mod(info.midi))?.note ?? noteName(info.midi,false)}{Math.floor(info.midi/12)-1}</strong><span>音级 {labels.get(mod(info.midi))?.degree ?? '调外音'} · {keyTitle}</span>{info.string !== undefined && <span>{info.string} 弦 · {info.fret} 品</span>}<button onClick={() => onNote(info.midi)}><Play size={13} /> 试听</button></div>}
  </section>
}
