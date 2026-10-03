import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Info, Minus, Music2, Play, Plus, Search, Volume2 } from 'lucide-react'
import { CHORDS, ROOTS, TUNINGS, chordVoicings, materialNotes, mod, noteName, type Material, type Position, type Tuning } from './theory.js'
import { HarmonyAudio } from './harmony-audio.js'
import './chord-lookup.css'

type Instrument = 'guitar' | 'bass' | 'ukulele' | 'piano'
type Filter = 'all' | 'open' | 'barre' | 'high'
type Shape = { title: string; voicing: Position[]; filter: Exclude<Filter, 'all'> }
const ROOT_LABELS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const PRIMARY_TYPES = ['major', 'minor', '7', 'maj7', 'm7', 'sus2', 'sus4', 'add9'] as const
const TYPE_LABELS: Record<string, string> = { major: 'Major', minor: 'Minor', '7': '7', maj7: 'Maj7', m7: 'm7', '9': '9', sus2: 'sus2', sus4: 'sus4', add9: 'add9', dim: 'dim', aug: 'aug', dim7: 'dim7', m7b5: 'm7♭5', power: '5' }
const FULL_NAMES: Record<string, string> = { major: 'Major / 大三和弦', minor: 'Minor / 小三和弦', '7': 'Dominant Seventh / 属七和弦', maj7: 'Major Seventh / 大七和弦', m7: 'Minor Seventh / 小七和弦' }
const FILTER_LABELS: Record<Filter, string> = { all: '全部', open: '开放和弦', barre: '封闭和弦', high: '高把位' }
const FRETS = [12, 15, 17, 24]

function chordName(root: number, quality: string): string {
  return `${ROOT_LABELS[root]}${quality === 'major' ? '' : quality === 'minor' ? 'm' : quality}`
}
function parseChord(text: string): { root: number; quality: string } | null {
  const match = /^\s*([A-Ga-g])([#♯b♭]?)(maj7|M7|m7b5|m7♭5|dim7|sus2|sus4|add9|minor|major|min|maj|m7|dim|aug|m|9|7|5)?\s*$/i.exec(text)
  if (!match) return null
  const rootName = match[1]!.toUpperCase() + (match[2] === '♯' ? '#' : match[2] === '♭' ? 'b' : match[2]!)
  const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[rootName[0] as 'C']
  const root = mod(natural + (rootName.endsWith('#') ? 1 : rootName.endsWith('b') ? -1 : 0))
  const suffix = match[3] ?? ''
  const quality = suffix === '' || /^(major|maj)$/i.test(suffix) ? 'major'
    : /^(minor|min|m)$/.test(suffix) ? 'minor'
      : suffix === 'M7' || /^maj7$/i.test(suffix) ? 'maj7'
        : suffix === '5' ? 'power' : suffix.replace('♭', 'b')
  return CHORDS[quality] ? { root, quality } : null
}
function positionsFromFrets(tuning: Tuning, frets: number[]): Position[] {
  return frets.flatMap((fret, index) => fret < 0 ? [] : [{ string: frets.length - index, fret, midi: tuning.notes[index]! + fret }])
}
function voicingCode(tuning: Tuning, voicing: Position[]): string {
  return tuning.notes.map((_, index) => {
    const fret = voicing.find(p => p.string === tuning.notes.length - index)?.fret
    return fret === undefined ? 'x' : String(fret)
  }).join(' · ')
}
function buildShapes(tuning: Tuning, root: number, chord: Material, quality: string, capo: number): Shape[] {
  if (tuning.id === 'guitar' && root === 0 && quality === 'maj7' && capo === 0) {
    return [
      { title: '开放和弦', filter: 'open', voicing: positionsFromFrets(tuning, [-1, 3, 2, 0, 0, 0]) },
      { title: '常用封闭', filter: 'barre', voicing: positionsFromFrets(tuning, [-1, 3, 5, 4, 5, 3]) },
      { title: '高把位', filter: 'high', voicing: positionsFromFrets(tuning, [8, -1, 9, 9, 8, -1]) }
    ]
  }
  const ranges: { title: string; filter: Shape['filter']; minFret: number; maxFret: number }[] = [
    { title: '低把位', filter: 'open', minFret: 0, maxFret: 4 },
    { title: '中把位', filter: 'barre', minFret: 3, maxFret: 8 },
    { title: '高把位', filter: 'high', minFret: 7, maxFret: 12 }
  ]
  const seen = new Set<string>()
  return ranges.flatMap(range => {
    const found = chordVoicings(tuning, root, chord, capo, { ...range, strings: [] }).find(v => {
      const key = voicingCode(tuning, v)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return found ? [{ title: range.title, filter: range.filter, voicing: found }] : []
  })
}
function toneClass(degree: string): string {
  if (degree === '1') return 'root'
  if (degree.includes('3') || degree.includes('7')) return 'guide'
  return 'fifth'
}
function ShapeDiagram({ shape, tuning, selected, onSelect, onPlay }: {
  shape: Shape; tuning: Tuning; selected: boolean; onSelect: () => void; onPlay: () => void
}): React.JSX.Element {
  const stopped = shape.voicing.filter(p => p.fret > 0).map(p => p.fret)
  const base = stopped.length ? Math.max(1, Math.min(...stopped)) : 1
  return <div className={`cl-shape ${selected ? 'selected' : ''}`}>
    <button className="cl-shape-main" aria-pressed={selected} onClick={onSelect}>
      <strong>{shape.title}</strong><span className="cl-shape-code">{voicingCode(tuning, shape.voicing)}</span>
      <svg viewBox="0 0 210 174" role="img" aria-label={`${shape.title}，按法 ${voicingCode(tuning, shape.voicing)}`}>
        {Array.from({ length: 5 }, (_, i) => <line key={`h${i}`} x1="35" x2="175" y1={39 + i * 29} y2={39 + i * 29} stroke="var(--border-strong)" strokeWidth={i === 0 && base === 1 ? 3 : 1} />)}
        {tuning.notes.map((_, i) => {
          const string = tuning.notes.length - i, x = 35 + i * 140 / (tuning.notes.length - 1)
          const fret = shape.voicing.find(p => p.string === string)?.fret
          return <g key={string}>
            <line x1={x} x2={x} y1="39" y2="155" stroke="var(--border-strong)" />
            <text x={x} y="28" textAnchor="middle" className="cl-string-marker">{fret === undefined ? '×' : fret === 0 ? '○' : ''}</text>
            {fret !== undefined && fret > 0 && <circle cx={x} cy={39 + (fret - base + .5) * 29} r="9" fill="var(--accent)" />}
          </g>
        })}
        {base > 1 && <text x="19" y="59" className="cl-base-fret">{base}</text>}
      </svg>
    </button>
    <button className="cl-shape-play" aria-label={`试听${shape.title}`} onClick={onPlay}><Volume2 size={16} /> 试听</button>
  </div>
}
function FretboardView({ tuning, root, chord, labels, degreeMode, fretCount, capo, highlight, route, onNote }: {
  tuning: Tuning; root: number; chord: Material; labels: string[]; degreeMode: boolean; fretCount: number; capo: number; highlight: Position[]; route?: Position[]; onNote: (midi: number) => void
}): React.JSX.Element {
  const active = new Set(highlight.map(p => `${p.string}:${p.fret}`))
  return <div className="cl-board-scroll"><div className="cl-board-wrap"><div className="cl-board" style={{ gridTemplateColumns: `62px repeat(${fretCount + 1}, 53px)` }} role="group" aria-label={`${tuning.name}全指板，0至${fretCount}品`}>
    <div className="cl-board-corner" />
    {Array.from({ length: fretCount + 1 }, (_, fret) => <div className="cl-board-fret" key={`f${fret}`}>{fret}</div>)}
    {[...tuning.notes].reverse().map((open, row) => {
      const string = row + 1
      return <div className="cl-board-row" key={string} style={{ gridColumn: `1 / span ${fretCount + 2}`, gridTemplateColumns: `62px repeat(${fretCount + 1}, 53px)` }}>
        <div className="cl-board-string">{noteName(open + capo, false)}</div>
        {Array.from({ length: fretCount + 1 }, (_, fret) => {
          const midi = open + capo + fret
          const index = chord.semitones.findIndex(interval => mod(interval) === mod(midi - root))
          const isActive = active.has(`${string}:${fret}`)
          return <div className={`cl-board-cell ${fret === 0 ? 'open' : ''}`} key={fret}>
            {index >= 0 && <button className={`cl-note ${toneClass(chord.degrees[index]!)} ${highlight.length && !isActive ? 'dimmed' : ''} ${isActive ? 'voicing' : ''}`} aria-label={`${string}弦${fret}品 ${labels[index]} ${chord.degrees[index]}`} onClick={() => onNote(midi)}>{degreeMode ? chord.degrees[index]!.replaceAll('b', '♭') : labels[index]}</button>}
          </div>
        })}
      </div>
    })}
  </div>{route && route.length > 1 && <svg className="cl-board-route" width={62 + 53 * (fretCount + 1)} height={28 + tuning.notes.length * 48} aria-hidden="true"><polyline points={route.map(p => `${62 + p.fret * 53 + 26.5},${28 + (p.string - 1) * 48 + 24}`).join(' ')} fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" /></svg>}</div></div>
}
function PianoView({ root, chord, labels, inversion, onNote }: { root: number; chord: Material; labels: string[]; inversion: number; onNote: (midi: number) => void }): React.JSX.Element {
  const voiced = chord.semitones.map(n => 48 + root + n)
  for (let i = 0; i < inversion; i++) voiced[i] = voiced[i]! + 12
  const selected = new Set(voiced)
  const white = [0, 2, 4, 5, 7, 9, 11]
  return <div className="cl-piano-scroll"><div className="cl-piano" role="group" aria-label="钢琴键盘 C3 至 B6">
    {Array.from({ length: 48 }, (_, offset) => {
      const midi = 48 + offset, pitch = mod(midi), isBlack = !white.includes(pitch)
      const whiteIndex = Math.floor(offset / 12) * 7 + white.filter(n => n < pitch).length
      const index = chord.semitones.findIndex(n => mod(n) === mod(midi - root))
      return <button key={midi} className={`cl-key ${isBlack ? 'black' : 'white'} ${index >= 0 ? toneClass(chord.degrees[index]!) : ''} ${selected.has(midi) ? 'voicing' : ''}`} style={{ left: isBlack ? whiteIndex * 42 - 12 : whiteIndex * 42 }} aria-label={`${noteName(midi)}${selected.has(midi) ? ' 当前转位' : ''}`} onClick={() => onNote(midi)}>{index >= 0 && <span>{labels[index]}</span>}</button>
    })}
  </div></div>
}
export function ChordLookup({ initialRoot, outputDeviceId, a4, onError }: { initialRoot: number; outputDeviceId: string; a4: number; onError: (message: string) => void }): React.JSX.Element {
  const [root, setRoot] = useState(initialRoot), [quality, setQuality] = useState('maj7')
  const [search, setSearch] = useState(''), [searchError, setSearchError] = useState('')
  const [mode, setMode] = useState<'lookup' | 'reverse'>('lookup'), [reverseNotes, setReverseNotes] = useState<number[]>([])
  const [instrument, setInstrument] = useState<Instrument>('guitar'), [bassStrings, setBassStrings] = useState<4 | 5>(4)
  const [lowG, setLowG] = useState(false), [filter, setFilter] = useState<Filter>('all')
  const [showBoard, setShowBoard] = useState(false), [degreeMode, setDegreeMode] = useState(false), [fretCount, setFretCount] = useState(12)
  const [bassView, setBassView] = useState<'tones' | 'route'>('tones')
  const [selectedShape, setSelectedShape] = useState<number | null>(null), [patternIndex, setPatternIndex] = useState(0)
  const [inversion, setInversion] = useState(0), [capo, setCapo] = useState(0), [more, setMore] = useState(false)
  const audio = useRef<HarmonyAudio | null>(null), errorRef = useRef(onError)
  errorRef.current = onError
  useEffect(() => { const engine = new HarmonyAudio(); engine.configure(.55, a4); audio.current = engine; return () => { engine.destroy(); audio.current = null } }, [])
  useEffect(() => { audio.current?.configure(.55, a4) }, [a4])
  useEffect(() => { void audio.current?.setOutput(outputDeviceId).catch(e => errorRef.current(`和弦试听输出不可用：${String(e)}`)) }, [outputDeviceId])
  const chord = CHORDS[quality]!
  const title = chordName(root, quality)
  const labels = useMemo(() => materialNotes(root, chord), [root, chord])
  const tuning = TUNINGS.find(t => t.id === (instrument === 'guitar' ? 'guitar' : instrument === 'bass' ? bassStrings === 5 ? 'bass-5' : 'bass' : lowG ? 'uke-low' : 'uke-high'))!
  const shapes = useMemo(() => instrument === 'bass' || instrument === 'piano' ? [] : buildShapes(tuning, root, chord, quality, capo), [instrument, tuning, root, chord, quality, capo])
  const visibleShapes = shapes.map((shape, index) => ({ ...shape, index })).filter(shape => filter === 'all' || shape.filter === filter)
  const bassPatterns = useMemo(() => {
    const orders = [chord.semitones, [chord.semitones[0]!, chord.semitones[2] ?? 7, chord.semitones.at(-1)!, chord.semitones[1] ?? 4], [...chord.semitones.slice(0, 3), 12]]
    return orders.map(order => order.map(interval => {
      const target = mod(root + interval), candidates: Position[] = []
      tuning.notes.forEach((open, index) => { for (let fret = 0; fret <= 12; fret++) if (mod(open + fret) === target) candidates.push({ string: tuning.notes.length - index, fret, midi: open + fret }) })
      return candidates.sort((a, b) => Math.abs(a.fret - 5) - Math.abs(b.fret - 5))[0]!
    }))
  }, [root, chord, tuning])
  const highlight = instrument === 'bass' ? bassView === 'route' ? bassPatterns[patternIndex] ?? [] : [] : selectedShape === null ? [] : shapes[selectedShape]?.voicing ?? []
  const audition = (notes: number[]): void => { void audio.current?.preview(notes).catch(e => errorRef.current(`无法试听和弦：${String(e)}`)) }
  const changeChord = (nextRoot: number, nextQuality = quality): void => { setRoot(mod(nextRoot)); setQuality(nextQuality); setSelectedShape(null); setInversion(0); setSearchError('') }
  const submitSearch = (): void => { const parsed = parseChord(search); if (parsed) { changeChord(parsed.root, parsed.quality); setMode('lookup') } else setSearchError('未识别这个和弦，请试试 Cmaj7、F#m7 或 Bb7。') }
  const matches = useMemo(() => Object.entries(CHORDS).flatMap(([id, item]) => ROOTS.flatMap((_, candidateRoot) => {
    const pcs = [...new Set(item.semitones.map(n => mod(n + candidateRoot)))].sort((a, b) => a - b)
    return pcs.length === reverseNotes.length && pcs.every((n, i) => n === [...reverseNotes].sort((a, b) => a - b)[i]) ? [{ root: candidateRoot, quality: id }] : []
  })).slice(0, 10), [reverseNotes])
  return <section className="chord-lookup" aria-label="和弦查询">
    <header className="cl-header"><div className="cl-title"><Music2 size={30} /><div><h1>和弦查询</h1><span>探索和弦，让音乐更简单</span></div></div><div className="cl-mode-tabs"><button aria-pressed={mode === 'lookup'} onClick={() => setMode('lookup')}>和弦查询</button><button aria-pressed={mode === 'reverse'} onClick={() => setMode('reverse')}>按音符反查</button></div></header>
    {mode === 'lookup' ? <>
      <div className="cl-search"><input aria-label="搜索和弦" value={search} onChange={e => { setSearch(e.target.value); setSearchError('') }} onKeyDown={e => { if (e.key === 'Enter') submitSearch() }} placeholder="搜索和弦，例如 Cmaj7、F#m7、Bb9" /><button aria-label="提交和弦搜索" onClick={submitSearch}><Search size={23} /></button></div>
      {searchError && <p className="cl-error" role="alert">{searchError}</p>}
      <div className="cl-picker"><span>根音：</span><div>{ROOT_LABELS.map((label, index) => <button key={index} aria-pressed={root === index} onClick={() => changeChord(index)}>{label}</button>)}</div></div>
      <div className="cl-picker"><span>和弦类型：</span><div>{PRIMARY_TYPES.map(id => <button key={id} aria-pressed={quality === id} onClick={() => changeChord(root, id)}>{TYPE_LABELS[id]}</button>)}<div className="cl-more"><button aria-expanded={more} onClick={() => setMore(!more)}>更多 <ChevronDown size={14} /></button>{more && <div className="cl-more-menu">{Object.keys(CHORDS).filter(id => !PRIMARY_TYPES.includes(id as typeof PRIMARY_TYPES[number])).map(id => <button key={id} onClick={() => { changeChord(root, id); setMore(false) }}>{TYPE_LABELS[id]}</button>)}</div>}</div></div></div>
      <section className="cl-summary"><div><h2>{title}</h2><div className="cl-summary-line"><span>构成音</span>{labels.map((label, index) => <b key={index} className={toneClass(chord.degrees[index]!)}>{label}</b>)}</div><div className="cl-summary-line"><span>音程序号</span>{chord.degrees.map((degree, index) => <b key={index}>{degree.replaceAll('b', '♭')}</b>)}</div><p>{FULL_NAMES[quality] ?? chord.name}</p></div><button className="cl-play" aria-label={`试听${title}`} onClick={() => audition(chord.semitones.map(n => 60 + root + n))}><Play size={27} fill="currentColor" /></button></section>
      <nav className="cl-instruments" aria-label="乐器">{([['guitar', '吉他'], ['bass', '贝斯'], ['ukulele', '尤克里里'], ['piano', '钢琴']] as const).map(([id, name]) => <button key={id} aria-pressed={instrument === id} onClick={() => { setInstrument(id); setFilter('all'); setSelectedShape(null) }}>{name}</button>)}</nav>
      <div className="cl-performance">
        {instrument === 'piano' ? <><div className="cl-section-heading"><h3>钢琴键盘</h3><span>C3 — B6 · 点击琴键试听</span></div><PianoView root={root} chord={chord} labels={labels} inversion={inversion} onNote={midi => audition([midi])} /><div className="cl-filter"><span>转位：</span>{chord.semitones.map((_, index) => <button key={index} aria-pressed={inversion === index} onClick={() => setInversion(index)}>{['原位', '第一转位', '第二转位', '第三转位', '第四转位'][index]}</button>)}</div></> : <>
          <div className="cl-section-heading"><h3>{instrument === 'bass' ? '常用和弦音型' : '常用按法'}</h3>{instrument === 'bass' && <div className="cl-inline-options"><button aria-pressed={bassStrings === 4} onClick={() => setBassStrings(4)}>4 弦</button><button aria-pressed={bassStrings === 5} onClick={() => setBassStrings(5)}>5 弦</button></div>}{instrument === 'ukulele' && <div className="cl-inline-options"><button aria-pressed={!lowG} onClick={() => setLowG(false)}>High G</button><button aria-pressed={lowG} onClick={() => setLowG(true)}>Low G</button></div>}</div>
          {instrument === 'bass' ? <div className="cl-bass-patterns">{['原位琶音', '根音–五音–七音–三音', '八度音型'].map((name, index) => <button key={name} aria-pressed={patternIndex === index} onClick={() => { setPatternIndex(index); audition(bassPatterns[index]!.map(p => p.midi)) }}><strong>{name}</strong><span>{bassPatterns[index]!.map(p => noteName(p.midi, false)).join(' → ')}</span><small>点击试听并在全指板突出路线</small></button>)}</div> : <>{visibleShapes.length ? <div className="cl-shapes">{visibleShapes.map(shape => <ShapeDiagram key={shape.index} shape={shape} tuning={tuning} selected={selectedShape === shape.index} onSelect={() => setSelectedShape(selectedShape === shape.index ? null : shape.index)} onPlay={() => audition(shape.voicing.map(p => p.midi))} />)}</div> : <p className="cl-empty">这个筛选条件下暂无完整按法，试试“全部”或其他和弦类型。</p>}<div className="cl-filter"><span>按法筛选：</span>{(Object.keys(FILTER_LABELS) as Filter[]).map(id => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{FILTER_LABELS[id]}</button>)}</div></>}
          <div className="cl-board-toggle"><div><strong>显示全指板</strong><span>查看当前和弦音在整件乐器上的位置</span></div><button role="switch" aria-checked={showBoard} aria-label="显示全指板" onClick={() => setShowBoard(!showBoard)}><i /></button></div>
          {showBoard && <section className="cl-board-panel"><div className="cl-board-toolbar"><div><h3>全指板</h3><span>{selectedShape !== null && instrument !== 'bass' ? '当前按法已突出显示' : instrument === 'bass' && bassView === 'route' ? '当前琶音路线已突出显示' : '点击任意音位试听'}</span></div><div className="cl-board-controls">{instrument === 'bass' && <div className="cl-inline-options"><button aria-pressed={bassView === 'tones'} onClick={() => setBassView('tones')}>和弦音</button><button aria-pressed={bassView === 'route'} onClick={() => setBassView('route')}>琶音路线</button></div>}<div className="cl-inline-options"><button aria-pressed={!degreeMode} onClick={() => setDegreeMode(false)}>音名</button><button aria-pressed={degreeMode} onClick={() => setDegreeMode(true)}>音级</button></div><label>显示范围 <select aria-label="全指板范围" value={fretCount} onChange={e => setFretCount(Number(e.target.value))}>{FRETS.map(n => <option key={n} value={n}>0–{n} 品</option>)}</select></label></div></div><FretboardView tuning={tuning} root={root} chord={chord} labels={labels} degreeMode={degreeMode} fretCount={fretCount} capo={capo} highlight={highlight} route={instrument === 'bass' && bassView === 'route' ? bassPatterns[patternIndex] : undefined} onNote={midi => audition([midi])} /><div className="cl-legend">{chord.degrees.map((degree, index) => <span key={index}><i className={toneClass(degree)} />{labels[index]} · {degree.replaceAll('b', '♭')}</span>)}</div></section>}
        </>}
        <div className="cl-bottom"><div><span>构成音</span><b>{labels.join('、')}</b></div><div><span>和弦类型</span><b>{FULL_NAMES[quality] ?? chord.name}</b></div>{instrument !== 'bass' && instrument !== 'piano' && <label>变调夹 <select aria-label="变调夹品位" value={capo} onChange={e => { setCapo(Number(e.target.value)); setSelectedShape(null) }}>{Array.from({ length: 13 }, (_, n) => <option key={n} value={n}>{n} 品</option>)}</select></label>}<div className="cl-transpose"><span>转调</span><button aria-label="降半音" onClick={() => changeChord(root - 1)}><Minus size={17} /></button><b>{ROOT_LABELS[root]}</b><button aria-label="升半音" onClick={() => changeChord(root + 1)}><Plus size={17} /></button></div></div>
      </div>
      <div className="cl-hint"><Info size={16} /> 点击按法图可在全指板突出显示；点击琴键或音位可试听单音。</div>
    </> : <div className="cl-reverse"><h2>按音符反查</h2><p>选择和弦里的音，查找可能的和弦。再次点击可取消。</p><div className="cl-reverse-notes">{ROOT_LABELS.map((name, index) => <button key={index} aria-pressed={reverseNotes.includes(index)} onClick={() => setReverseNotes(old => old.includes(index) ? old.filter(n => n !== index) : [...old, index])}>{name}</button>)}</div><h3>匹配和弦</h3>{reverseNotes.length ? matches.length ? <div className="cl-matches">{matches.map(item => <button key={`${item.root}-${item.quality}`} onClick={() => { changeChord(item.root, item.quality); setMode('lookup') }}>{chordName(item.root, item.quality)} <span>{CHORDS[item.quality]!.name}</span></button>)}</div> : <p className="cl-empty">暂无完全匹配的和弦，可再选一个音或调整所选音。</p> : <p className="cl-empty">先选择至少两个音。</p>}</div>}
  </section>
}
