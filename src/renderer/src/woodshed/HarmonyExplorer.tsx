import { useEffect, useMemo, useRef, useState } from 'react'
import { Guitar, Piano, PanelsTopLeft, Play, Square, Repeat2, Volume2, Music2, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { CHORDS, SCALES, mod } from './theory.js'
import { diatonicChords, harmonyLabels, harmonyRootName, instrumentNames, keyName, keySignature, PROGRESSIONS, type HarmonyMode, type HarmonyInstrument } from './harmony.js'
import { HarmonyDial } from './HarmonyDial.js'
import { HarmonyInstrumentView, DEFAULT_CONFIGS } from './HarmonyInstruments.js'
import { HarmonyAudio, type HarmonyStep } from './harmony-audio.js'
import { readMetronome, clampBpm } from './metronome-engine.js'
import './harmony.css'

const MODES: [HarmonyMode, string][] = [['key','调性 Key'],['chord','和弦 Chord'],['scale','音阶 Scale'],['progression','进行 Progression']]
const INSTRUMENTS: (HarmonyInstrument | 'dual')[] = ['guitar','bass','ukulele','piano','dual']
export function HarmonyExplorer({ root, onRoot, outputDeviceId, a4, onError }: {
  root: number; onRoot: (root: number) => void; outputDeviceId: string; a4: number; onError: (message: string) => void
}): React.JSX.Element {
  const [mode,setMode] = useState<HarmonyMode>('key'), [minor,setMinor] = useState(false)
  const [chord,setChord] = useState('major'), [scale,setScale] = useState('major')
  const [focus,setFocus] = useState<number | null>(null), [degree,setDegree] = useState(false)
  const [instrument,setInstrument] = useState<HarmonyInstrument | 'dual'>('dual')
  const [primary,setPrimary] = useState<HarmonyInstrument>('guitar'), [secondary,setSecondary] = useState<HarmonyInstrument>('piano')
  const [dualSettings,setDualSettings] = useState(false), [configs,setConfigs] = useState(DEFAULT_CONFIGS)
  const [selected,setSelected] = useState<number | null>(null)
  const [progression,setProgression] = useState(0), [bpm,setBpm] = useState(() => readMetronome().bpm)
  const [loop,setLoop] = useState(false), [volume,setVolume] = useState(.5), [descending,setDescending] = useState(false)
  const [playing,setPlaying] = useState(false), [cursor,setCursor] = useState(-1)
  const engine = useRef<HarmonyAudio | null>(null), errorRef = useRef(onError)
  errorRef.current = onError
  useEffect(() => { const audio = new HarmonyAudio(); engine.current = audio; return () => { audio.destroy(); engine.current = null } }, [])
  useEffect(() => { void engine.current?.setOutput(outputDeviceId).catch(e => { engine.current?.stop(); setPlaying(false); setCursor(-1); errorRef.current(`和声播放输出不可用：${String(e)}`) }) }, [outputDeviceId])
  useEffect(() => { engine.current?.configure(volume,a4) }, [volume,a4])
  const chords = useMemo(() => diatonicChords(root,minor),[root,minor])
  const progressionDegrees = PROGRESSIONS[progression]!.degrees
  const focused = mode === 'progression' && cursor >= 0 ? progressionDegrees[cursor]! : focus
  const activeChord = focused !== null ? chords[focused]! : null
  const objectRoot = activeChord?.root ?? root
  const material = activeChord?.material ?? (mode === 'chord' ? CHORDS[chord]! : mode === 'scale' ? SCALES[scale]! : SCALES[minor ? 'minor' : 'major']!)
  const spelling = activeChord ? activeChord.name.replace(/dim$|m$/,'') : harmonyRootName(root,minor)
  const labels = useMemo(() => harmonyLabels(objectRoot,material,spelling),[objectRoot,material,spelling])
  const chordPcs = activeChord || mode === 'chord' ? material.semitones.map(n => mod(objectRoot+n)) : mode === 'scale' ? [] : (minor ? [0,3,7] : [0,4,7]).map(n => mod(root+n))
  const keyTitle = keyName(root,minor)
  const title = activeChord ? activeChord.name : mode === 'chord' ? `${spelling} ${chord === 'major' ? 'Major' : chord === 'minor' ? 'Minor' : chord}` : mode === 'scale' ? `${spelling} · ${SCALES[scale]!.name}` : keyTitle
  const stop = (): void => { engine.current?.stop(); setPlaying(false); setCursor(-1); setSelected(null) }
  useEffect(() => { engine.current?.stop(); setPlaying(false); setCursor(-1); setSelected(null); setFocus(null) },[root,minor,mode,chord,scale,progression,bpm,loop,descending])
  const preview = (notes: number[]): void => { void engine.current?.preview(notes).catch(e => errorRef.current(`无法试听：${String(e)}`)) }
  const onNote = (midi: number): void => { setSelected(mod(midi)); preview([midi]) }
  const selectChord = (i: number): void => {
    stop(); setFocus(focus === i ? null : i)
    const item = chords[i]!; preview(item.material.semitones.map(n => 48+item.root+n))
  }
  const start = (): void => {
    if (playing) { stop(); return }
    let steps: HarmonyStep[]
    if (mode === 'progression') { setFocus(null); steps = progressionDegrees.map(i => { const c = chords[i]!; return { notes: c.material.semitones.map(n => 48+c.root+n), beats: 4 } }) }
    else if (activeChord || mode === 'chord') steps = [{ notes: material.semitones.map(n => 48+objectRoot+n), beats: 4 }]
    else { const notes = [...material.semitones,12].map(n => 60+objectRoot+n); if (descending) notes.reverse(); steps = notes.map(n => ({ notes: [n], beats: 1 })) }
    setPlaying(true)
    void engine.current?.play(steps,bpm,loop,i => { setCursor(i); if (mode !== 'progression') setSelected(mod(steps[i]!.notes[0]!)) },() => { setPlaying(false); setCursor(-1); setSelected(null) }).catch(e => { setPlaying(false); setCursor(-1); errorRef.current(`无法播放：${String(e)}`) })
  }
  const mapping = (item: HarmonyInstrument): React.JSX.Element => <HarmonyInstrumentView key={item} instrument={item} config={configs[item]} onConfig={value => setConfigs(old => ({ ...old,[item]:value }))} labels={labels} chordPcs={chordPcs} root={objectRoot} degree={degree} selected={selected} keyTitle={keyTitle} onNote={onNote} />
  return <section className="harmony-explorer" aria-label="Harmony Explorer 五度圈">
    <header className="he-toolbar"><div className="he-brand"><Music2 size={30} /><div><h2>Harmony Explorer</h2><span>SEE MUSIC · PLAY MUSIC · UNDERSTAND MUSIC</span></div></div>
      <nav className="he-modes" aria-label="和声工作模式">{MODES.map(([id,label]) => <button key={id} aria-pressed={mode === id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>{label}</button>)}</nav>
      <label className="he-volume"><Volume2 size={17} /><input aria-label="和声试听音量" type="range" min="0" max="1" step=".01" value={volume} onChange={e => setVolume(Number(e.target.value))} /></label>
    </header>
    <div className="he-layout"><HarmonyDial root={root} minor={minor} activeRoot={activeChord?.root ?? null} onRoot={onRoot} onMinor={setMinor} />
      <div className="he-mapping">
        <section className="he-context" onClick={e => { if (e.target === e.currentTarget) setFocus(null) }}>
          <div className="he-context-top"><h1>{title}</h1><div className="he-display"><button aria-pressed={!degree} className={!degree ? 'active' : ''} onClick={() => setDegree(false)}>音名 Note</button><button aria-pressed={degree} className={degree ? 'active' : ''} onClick={() => setDegree(true)}>音级 Degree</button></div></div>
          <div className="he-context-body"><div className="he-object-info"><div className="he-note-list" aria-live="polite">{[...labels.values()].map((n,i) => <span key={i}>{degree ? n.degree : n.note}</span>)}</div><p>{mode === 'chord' || mode === 'scale' || activeChord ? material.degrees.join(' · ').replaceAll('b','♭') : keySignature(root,minor)}</p><small>{activeChord ? `${keyTitle} · ${activeChord.degree} 级和弦` : '让和声关系，成为看得见的音乐。'}</small></div>
          <div className="he-degrees"><span>Scale Degrees</span><div>{chords.map((c,i) => <button key={i} className={focused === i ? 'active' : ''} onClick={() => selectChord(i)} aria-label={`聚焦 ${c.name}`}><small>{c.degree}</small><b>{c.name}</b></button>)}</div></div></div>
          <div className="he-mode-controls">
            {mode === 'chord' && <label>和弦类型 <select aria-label="和弦类型" value={chord} onChange={e => setChord(e.target.value)}>{Object.entries(CHORDS).map(([id,c]) => <option key={id} value={id}>{c.name}</option>)}</select></label>}
            {mode === 'scale' && <label>音阶 <select aria-label="音阶类型" value={scale} onChange={e => setScale(e.target.value)}>{Object.entries(SCALES).map(([id,c]) => <option key={id} value={id}>{c.name}</option>)}</select></label>}
            {mode === 'progression' && <label>常用进行 <select aria-label="和弦进行" value={progression} onChange={e => setProgression(Number(e.target.value))}>{PROGRESSIONS.map((p,i) => <option key={i} value={i}>{p.degrees.map(d => chords[d]!.degree).join(' – ')}</option>)}</select><span className="he-progression-names">{progressionDegrees.map(i => chords[i]!.name).join(' → ')}</span></label>}
            {activeChord && !playing && <button onClick={() => setFocus(null)}><X size={12} /> 返回 {keyTitle}</button>}
          </div>
        </section>
        <nav className="he-instrument-tabs" aria-label="乐器映射">{INSTRUMENTS.map(item => { const Icon = item === 'piano' ? Piano : item === 'dual' ? PanelsTopLeft : Guitar; return <button key={item} className={instrument === item ? 'active' : ''} aria-pressed={instrument === item} onClick={() => { setInstrument(item); if (item === 'dual') setDualSettings(true) }}><Icon size={22} />{item === 'dual' ? 'Dual' : instrumentNames[item]}</button> })}</nav>
        {instrument === 'dual' && dualSettings && <div className="he-dual-settings"><label>Primary <select aria-label="主乐器" value={primary} onChange={e => { const next = e.target.value as HarmonyInstrument; setPrimary(next); if (next === secondary) setSecondary(primary) }}>{Object.entries(instrumentNames).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>Secondary <select aria-label="副乐器" value={secondary} onChange={e => setSecondary(e.target.value as HarmonyInstrument)}>{Object.entries(instrumentNames).filter(([id]) => id !== primary).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label><button className="he-icon" aria-label="收起双显设置" onClick={() => setDualSettings(false)}><X size={15} /></button></div>}
        <div className="he-legend"><span><i className="root" />Root 根音</span><span><i className="chord" />Chord Tone 和弦音</span><span><i className="scale" />Scale Tone 音阶音</span><span><i className="other" />Other</span></div>
        {instrument === 'dual' ? <>{mapping(primary)}{mapping(secondary)}</> : mapping(instrument)}
        <div className="he-bottom"><section className="he-harmony-strip"><header><b>{mode === 'progression' ? '和弦进行' : '调内和弦'}</b><span>{mode === 'progression' ? progressionDegrees.map(i => chords[i]!.degree).join(' – ') : `Diatonic Chords (${keyTitle})`}</span></header><div>{(mode === 'progression' ? progressionDegrees : [0,1,2,3,4,5,6]).map((i,index) => <button key={index} aria-pressed={mode === 'progression' && playing ? cursor === index : focused === i} className={(mode === 'progression' && playing ? cursor === index : focused === i) ? 'active' : ''} onClick={() => selectChord(i)}><span>{chords[i]!.degree}</span><b>{chords[i]!.name}</b></button>)}</div></section>
          <section className="he-playback"><div><button className="he-play" aria-label={playing ? '停止和声播放' : '播放和声'} onClick={start}>{playing ? <Square size={21} /> : <Play size={24} fill="currentColor" />}</button><label><input aria-label="和声 BPM" type="number" min="30" max="240" value={bpm} onChange={e => setBpm(clampBpm(Number(e.target.value) || 30))} /><span>BPM</span></label><button className={loop ? 'active' : ''} aria-pressed={loop} onClick={() => setLoop(!loop)}><Repeat2 size={16} />Loop</button></div>{mode !== 'progression' && mode !== 'chord' && !activeChord && <button className="he-direction" onClick={() => setDescending(!descending)}>{descending ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}{descending ? 'Descending 下行' : 'Ascending 上行'}</button>}</section>
        </div>
      </div>
    </div><footer className="he-footer"><span><Music2 size={14} /> All Instruments · All Keys · A More Musical You</span><span>EXPLORE · PRACTICE · CREATE · GROW</span></footer>
  </section>
}
