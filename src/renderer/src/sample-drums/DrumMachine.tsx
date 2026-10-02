import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Drum, Eraser, Heart, Keyboard, Music2, Pause, Play, RotateCcw, Settings2, SlidersHorizontal, Square, Trash2, Volume2, X } from 'lucide-react'
import { SelectMenu } from '../components/SelectMenu.js'
import { DrumAudio } from './drum-audio.js'
import { DRUM_PRESETS, PAD_KEYS, DEFAULT_PADS, SAMPLE_NOTES, capturePad, cloneDraft, presetDraft, quantizedStep, readDrumState, resizeDraft, saveDrumState, stepCount, writeHit, type DrumDraft, type DrumSample } from './drum-patterns.js'
import './drum-machine.css'

const sampleBase = (): string => window.location.protocol === 'file:' ? 'bandbuddy-media://drum/' : new URL('woodshed/drums/', document.baseURI).href
const shortName = (sample?: DrumSample): string => sample?.nameZh.replace(/（.*?）/g, '').replace('·常规踩击', '').replace('·常规击', '').replace('16 英寸', '16″').replace('18 英寸', '18″').replace('22 英寸', '22″').replace('10 英寸', '10″') ?? '载入音色…'
const group = (sample: DrumSample): string => ({ '01-kicks': '底鼓', '02-snares': '军鼓', '03-hi-hats': '踩镲', '04-toms': '通鼓', '05-cymbals': '镲片', '06-percussion': '打击乐' })[sample.file.split('/')[0]!] ?? '其他'
interface SoundTarget { kind: 'pad' | 'track'; id: string | number }

export function DrumMachine({ outputDeviceId = '', onError, onBack }: { outputDeviceId?: string; onError: (message: string) => void; onBack: () => void }): React.JSX.Element {
  const [machine, setMachine] = useState(readDrumState)
  const [mode, setMode] = useState<'steps' | 'pads'>('steps')
  const [samples, setSamples] = useState<DrumSample[]>([])
  const [sampleError, setSampleError] = useState('')
  const [retry, setRetry] = useState(0)
  const [playing, setPlaying] = useState(false), [loading, setLoading] = useState(false), [step, setStep] = useState(-1)
  const [custom, setCustom] = useState(false), [saveOpen, setSaveOpen] = useState(false), [presetName, setPresetName] = useState('')
  const [soundTarget, setSoundTarget] = useState<SoundTarget | null>(null), [soundGroup, setSoundGroup] = useState('全部')
  const [flashes, setFlashes] = useState<number[]>([])
  const [engine] = useState(() => new DrumAudio())
  const live = useRef({ machine, playing, loading, custom, samples, mode, soundTarget, saveOpen })
  live.current = { machine, playing, loading, custom, samples, mode, soundTarget, saveOpen }
  const request = useRef(0), errorRef = useRef(onError), storageFailed = useRef(false)
  const resumeStep = useRef(0)
  errorRef.current = onError
  const repeats = useRef(new Map<number, ReturnType<typeof setInterval>>())
  const flashTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const teardown = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editor = useRef<HTMLDivElement>(null)
  const editorReturnScroll = useRef<number | null>(null)
  const root = useRef<HTMLElement>(null)
  const base = sampleBase(), draft = machine.draft, length = stepCount(draft)
  const findSample = (note: number): DrumSample | undefined => samples.find(sample => sample.midiNote === note)
  const changeDraft = (change: (draft: DrumDraft) => DrumDraft): void => setMachine(old => ({ ...old, draft: change(old.draft) }))
  const clearRepeats = useCallback(() => { for (const timer of repeats.current.values()) clearInterval(timer); repeats.current.clear() }, [])
  const stop = useCallback(() => {
    request.current++; resumeStep.current = 0; engine.stop(); clearRepeats(); setPlaying(false); setLoading(false); setStep(-1)
  }, [engine, clearRepeats])
  useEffect(() => {
    const controller = new AbortController()
    setSampleError('')
    void fetch(new URL('manifest.json', base), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('无法读取鼓音源清单')
      const manifest = await response.json() as { samples: DrumSample[] }
      if (!Array.isArray(manifest.samples) || manifest.samples.length !== 34 || !manifest.samples.every(sample =>
        SAMPLE_NOTES.includes(sample.midiNote) && typeof sample.nameZh === 'string' && typeof sample.file === 'string' &&
        /^0[1-6]-[\w-]+\/[^/]+\.flac$/.test(sample.file)) || new Set(manifest.samples.map(sample => sample.midiNote)).size !== 34) throw new Error('鼓音源清单不完整')
      if (!controller.signal.aborted) setSamples(manifest.samples)
    }).catch(error => { if (!controller.signal.aborted) setSampleError(error instanceof Error ? error.message : String(error)) })
    return () => controller.abort()
  }, [base, retry])
  useEffect(() => { void engine.setOutput(outputDeviceId).catch(error => errorRef.current(String(error))) }, [engine, outputDeviceId])
  useEffect(() => {
    if (!saveDrumState(machine) && !storageFailed.current) { storageFailed.current = true; errorRef.current('本地存储不可用，节奏和打击垫设置无法在重启后恢复。') }
    engine.setVolume(machine.draft.volume)
  }, [machine, engine])
  useEffect(() => {
    // React StrictMode rehearses cleanup and setup using the same engine instance.
    if (teardown.current) clearTimeout(teardown.current)
    return () => {
      request.current++; engine.stop(); clearRepeats()
      for (const timer of flashTimers.current.values()) clearTimeout(timer)
      teardown.current = setTimeout(() => engine.destroy(), 0)
    }
  }, [engine, clearRepeats])
  useEffect(() => { if (soundTarget) editor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [soundTarget])
  useLayoutEffect(() => {
    if (!soundTarget && editorReturnScroll.current !== null) {
      root.current?.closest('.ws-scroll')?.scrollTo({ top: editorReturnScroll.current, behavior: 'instant' })
      editorReturnScroll.current = null
    }
  }, [soundTarget])
  const start = async (): Promise<void> => {
    if (!samples.length || loading) return
    const ticket = ++request.current
    setLoading(true)
    try {
      const started = await engine.play(() => live.current.machine.draft, samples, base, next => {
        setStep(next)
        const current = live.current.machine
        current.pads.forEach((note, index) => {
          if (current.draft.tracks.some(track => track.sample === note && track.hits[next]! > 0)) flash(index)
        })
      }, resumeStep.current)
      if (ticket === request.current && started) setPlaying(true)
    } catch (error) { if (ticket === request.current) errorRef.current(error instanceof Error ? error.message : String(error)) }
    finally { if (ticket === request.current) setLoading(false) }
  }
  const pause = (): void => {
    const next = (step + 1) % length
    stop(); resumeStep.current = Math.max(0, next)
  }
  const flash = useCallback((index: number): void => {
    clearTimeout(flashTimers.current.get(index))
    setFlashes(old => old.includes(index) ? old : [...old, index])
    flashTimers.current.set(index, setTimeout(() => { setFlashes(old => old.filter(item => item !== index)); flashTimers.current.delete(index) }, 140))
  }, [])
  const hitPad = useCallback((index: number): void => {
    const current = live.current, note = current.machine.pads[index]!, sample = current.samples.find(item => item.midiNote === note)
    if (!sample) return
    flash(index)
    void engine.hit(sample, base, current.machine.velocity, current.machine.draft.volume).catch(error => errorRef.current(String(error)))
    if (current.custom && current.playing) {
      const at = quantizedStep(engine.elapsed(), current.machine.draft, current.machine.quantize)
      setMachine(old => ({ ...old, draft: capturePad(old.draft, note, at, current.machine.velocity) }))
    }
  }, [engine, base, flash])
  const release = useCallback((index: number): void => { clearInterval(repeats.current.get(index)); repeats.current.delete(index) }, [])
  const press = useCallback((index: number): void => {
    if (repeats.current.has(index)) return
    hitPad(index)
    if (live.current.machine.repeat) repeats.current.set(index, setInterval(() => hitPad(index), 60_000 / live.current.machine.draft.bpm * 4 / live.current.machine.quantize))
  }, [hitPad])
  useEffect(() => {
    clearRepeats()
  }, [machine.repeat, machine.quantize, machine.draft.bpm, mode, soundTarget, saveOpen, clearRepeats])
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      const current = live.current
      if (current.mode !== 'pads' || current.soundTarget || current.saveOpen || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
        (event.target as HTMLElement)?.closest('input,select,textarea,[contenteditable="true"],[role="combobox"],[role="listbox"]')) return
      const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.startsWith('Digit') ? event.code.slice(5) : ''
      const index = PAD_KEYS.findIndex(item => item === key)
      if (index >= 0) { event.preventDefault(); press(index) }
    }
    const up = (event: KeyboardEvent): void => {
      const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.startsWith('Digit') ? event.code.slice(5) : ''
      const index = PAD_KEYS.findIndex(item => item === key)
      if (index >= 0) release(index)
    }
    const visibility = (): void => { if (document.hidden) clearRepeats() }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clearRepeats)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clearRepeats); document.removeEventListener('visibilitychange', visibility) }
  }, [press, release, clearRepeats])
  const selectPreset = (id: string): void => {
    stop(); setCustom(false); setSaveOpen(false)
    setMachine(old => ({ ...old, selected: id, draft: cloneDraft(old.presets.find(item => item.id === id)?.draft ?? presetDraft(id)) }))
  }
  const makeCustom = (): void => {
    stop(); setCustom(true); setSaveOpen(false); setPresetName('')
    setMachine(old => ({ ...old, selected: 'custom', draft: { ...old.draft, tracks: old.draft.tracks.map(track => ({ ...track, hits: Array(length).fill(0) })) } }))
  }
  const savePreset = (): void => {
    const name = presetName.trim()
    if (!name) return
    if (machine.presets.length >= 64 && !machine.presets.some(item => item.id === machine.selected)) { errorRef.current('最多保存 64 个预设，请先删除不需要的预设。'); return }
    const existing = machine.presets.find(item => item.id === machine.selected)
    const id = existing?.id ?? `user-${crypto.randomUUID()}`
    setMachine(old => ({ ...old, selected: id, presets: [...old.presets.filter(item => item.id !== id), { id, name, draft: cloneDraft(old.draft) }] }))
    setSaveOpen(false); setCustom(false)
  }
  const openSound = (target: SoundTarget): void => {
    if (!soundTarget) editorReturnScroll.current = root.current?.closest('.ws-scroll')?.scrollTop ?? 0
    clearRepeats(); setSoundTarget(target); setSoundGroup('全部')
  }
  const soundNote = soundTarget?.kind === 'pad' ? machine.pads[Number(soundTarget.id)] : draft.tracks.find(track => track.id === soundTarget?.id)?.sample
  const activePreset = machine.presets.find(item => item.id === machine.selected)
  const hasHit = (i: number): boolean => draft.tracks.some(track => track.hits[i]! > 0)
  return <section ref={root} className={`dm dm-${mode}`} aria-label="鼓机">
    <header className="dm-heading">
      <div className="dm-title"><Music2 size={33} /><h2>{mode === 'steps' ? '鼓机' : '打击垫'}</h2><p>{mode === 'steps' ? '编排节奏，让律动更简单' : '即兴敲击，快速编入节奏'}</p></div>
      <div className="dm-tabs" aria-label="鼓机模式"><button aria-pressed={mode === 'steps'} onClick={() => setMode('steps')}>步进编排</button><button aria-pressed={mode === 'pads'} onClick={() => setMode('pads')}>打击垫</button></div>
    </header>
    <div className="dm-transport dm-panel">
      <div className="dm-transport-buttons">
        <button className="dm-button dm-primary" disabled={!samples.length || loading} onClick={() => playing ? pause() : void start()}>{playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}{loading ? '载入中…' : playing ? '暂停' : '播放'}</button>
        <button className="dm-button" onClick={stop}><Square size={15} fill="currentColor" />停止</button>
        <button className="dm-button" aria-pressed={custom} title={custom ? '结束节奏编入' : '创建空白节奏预设'} onClick={() => custom ? setCustom(false) : makeCustom()}><SlidersHorizontal size={16} />自定义</button>
      </div>
      <div className="dm-bpm"><span>BPM</span><button aria-label="降低鼓机速度" onClick={() => { stop(); changeDraft(old => ({ ...old, bpm: Math.max(40, old.bpm - 1) })) }}>−</button><input aria-label="鼓机速度 BPM" type="number" min="40" max="240" value={draft.bpm} onChange={event => { stop(); changeDraft(old => ({ ...old, bpm: Math.max(40, Math.min(240, Math.round(Number(event.target.value)) || 40)) })) }} /><button aria-label="提高鼓机速度" onClick={() => { stop(); changeDraft(old => ({ ...old, bpm: Math.min(240, old.bpm + 1) })) }}>+</button></div>
      <label className="dm-meter">拍号<SelectMenu ariaLabel="鼓机拍号与小节" value={draft.beats * 10 + draft.bars} options={[2, 3, 4].flatMap(beats => [1, 2].map(bars => ({ value: beats * 10 + bars, label: `${beats}/4 · ${bars}小节` })))} onChange={value => { stop(); changeDraft(old => resizeDraft(old, Math.floor(value / 10), value % 10)) }} /></label>
      {mode === 'steps' ? <label className="dm-range">Swing<input aria-label="鼓机 Swing" style={{ '--dm-fill': `${draft.swing}%` } as React.CSSProperties} type="range" min="0" max="100" value={draft.swing} onChange={event => { stop(); changeDraft(old => ({ ...old, swing: Number(event.target.value) })) }} /><output>{draft.swing}%</output></label>
        : <label className="dm-quantize">录入量化<SelectMenu ariaLabel="打击垫录入量化" value={machine.quantize} options={[4, 8, 16].map(value => ({ value, label: `1/${value}` }))} onChange={quantize => setMachine(old => ({ ...old, quantize }))} /></label>}
      <label className="dm-range dm-volume"><Volume2 size={17} /><span>音量</span><input aria-label="鼓机主音量" style={{ '--dm-fill': `${draft.volume * 100}%` } as React.CSSProperties} type="range" min="0" max="100" value={Math.round(draft.volume * 100)} onChange={event => changeDraft(old => ({ ...old, volume: Number(event.target.value) / 100 }))} /><output>{Math.round(draft.volume * 100)}%</output></label>
    </div>
    {sampleError && <div role="alert" className="dm-error">{sampleError}<button className="dm-button" onClick={() => setRetry(old => old + 1)}>重试</button></div>}
    {custom && <div role="status" className="dm-custom-hint"><SlidersHorizontal size={15} /><span>自定义节奏 · 点击方格编排；播放后敲击打击垫，自动量化写入当前片段。</span><button onClick={() => setCustom(false)}>结束编入</button></div>}
    {mode === 'steps' ? <div className="dm-sequencer dm-panel">
      <div className="dm-section-heading"><h3>节奏编排</h3><p>点击方格开启 / 关闭声音，点击左侧选择音色</p><div><button className="dm-button" onClick={() => changeDraft(old => ({ ...old, tracks: old.tracks.map(track => ({ ...track, hits: Array(length).fill(0) })) }))}><Eraser size={16} />清空</button><details className="dm-more"><summary className="dm-button">更多操作<ChevronDown size={14} /></summary><div><button onClick={() => { stop(); changeDraft(old => ({ ...old, tracks: old.tracks.map(track => ({ ...track, hits: track.hits.map((_, i) => track.hits[(i + length - 1) % length]!) })) })) }}>节奏右移一步</button><button onClick={() => { stop(); selectPreset(machine.selected === 'custom' ? 'rock' : machine.selected) }}>恢复当前预设</button><button onClick={() => { stop(); changeDraft(old => ({ ...old, tracks: [...old.tracks, { id: crypto.randomUUID(), name: '新鼓轨', sample: 56, hits: Array(length).fill(0) }] })) }} disabled={draft.tracks.length >= 42}>添加鼓轨</button></div></details></div></div>
      <div className="dm-grid-scroll"><div className="dm-grid" style={{ '--dm-steps': length } as React.CSSProperties} role="group" aria-label="鼓机步进音序器">
        <div className="dm-grid-header"><span />{Array.from({ length }, (_, i) => <span key={i} className={`${i % 4 === 0 ? 'beat' : ''} ${step === i ? 'current' : ''}`}>{i % 4 === 0 ? Math.floor(i / 4) % draft.beats + 1 : ['e', '&', 'a'][i % 4 - 1]}</span>)}</div>
        {draft.tracks.map(track => <div className="dm-grid-row" key={track.id}>
          <button className="dm-lane" aria-label={`${track.name}音色`} title={findSample(track.sample)?.nameZh} onClick={() => openSound({ kind: 'track', id: track.id })}><Drum size={21} /><span><b>{track.name === '打击垫' || track.name === '新鼓轨' ? group(findSample(track.sample) ?? { file: '', midiNote: 0, nameZh: '', articulation: '' }) : track.name}</b><small>{shortName(findSample(track.sample))}</small></span><ChevronDown size={12} /></button>
          {track.hits.map((velocity, i) => <button key={i} aria-label={`${track.name} 第 ${i + 1} 步`} aria-pressed={velocity > 0} className={`dm-step ${i % 4 === 0 ? 'beat-start' : ''} ${step === i ? 'current' : ''}`} onClick={() => changeDraft(old => writeHit(old, track.id, i, velocity > 0 ? 0 : machine.velocity))} />)}
        </div>)}
      </div></div>
    </div> : <>
      <div className="dm-pad-panel dm-panel"><div className="dm-pad-grid">{PAD_KEYS.map((key, index) => <div className={`dm-pad-shell ${flashes.includes(index) ? 'hit' : ''}`} key={key}>
        <button className="dm-pad" aria-label={`打击垫 ${key.toUpperCase()} ${findSample(machine.pads[index]!)?.nameZh ?? ''}`} disabled={!samples.length} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); press(index) }} onPointerUp={() => release(index)} onPointerCancel={() => release(index)} onLostPointerCapture={() => release(index)} onClick={event => { if (event.detail === 0) hitPad(index) }}><i /><strong>{shortName(findSample(machine.pads[index]!))}</strong><kbd>{key.toUpperCase()}</kbd></button>
        <button className="dm-pad-config" aria-label={`自定义打击垫 ${key.toUpperCase()} 音色`} title="更换音色" onClick={() => openSound({ kind: 'pad', id: index })}><Settings2 size={15} /></button>
      </div>)}</div></div>
      <div className="dm-pad-controls dm-panel"><label className="dm-range">力度<input aria-label="打击垫力度" style={{ '--dm-fill': `${machine.velocity * 100}%` } as React.CSSProperties} type="range" min="10" max="100" value={Math.round(machine.velocity * 100)} onChange={event => setMachine(old => ({ ...old, velocity: Number(event.target.value) / 100 }))} /><output>{Math.round(machine.velocity * 100)}%</output></label><label className="dm-repeat">连击<button role="switch" aria-checked={machine.repeat} aria-label="打击垫连击" onClick={() => setMachine(old => ({ ...old, repeat: !old.repeat }))}><i /></button><small>按住按键 / 打击垫</small></label><div className="dm-clip"><span>当前片段 · {draft.bars}小节</span><div>{Array.from({ length }, (_, i) => <i key={i} className={`${hasHit(i) ? 'filled' : ''} ${step === i ? 'current' : ''}`} />)}</div></div><button className="dm-button" onClick={() => setMachine(old => ({ ...old, pads: [...DEFAULT_PADS] }))}><RotateCcw size={14} />恢复音色</button></div>
      <footer className="dm-pad-footer"><span><Keyboard size={17} />键盘快捷键：1 2 3 4 / Q W E R / A S D F / Z X C V</span><span>点击右上角设置，独立选择每个打击垫的音色</span></footer>
    </>}
    <div className="dm-presets dm-panel"><div className="dm-preset-title"><h3>节奏预设</h3><small>快速应用经典节奏型</small></div><div className="dm-preset-list">{DRUM_PRESETS.map(preset => <button key={preset.id} className="dm-button" aria-pressed={machine.selected === preset.id} onClick={() => selectPreset(preset.id)}>{preset.name}</button>)}{machine.presets.map(preset => <button key={preset.id} className="dm-button" aria-pressed={machine.selected === preset.id} onClick={() => selectPreset(preset.id)}>{preset.name}</button>)}</div><button className="dm-button dm-save" onClick={() => { setPresetName(activePreset?.name ?? '我的节奏'); setSaveOpen(true); clearRepeats() }}><Heart size={17} />{activePreset ? '保存预设修改' : '保存为我的预设'}</button></div>
    {saveOpen && <form className="dm-save-panel dm-panel" onSubmit={event => { event.preventDefault(); savePreset() }}><label>预设名称<input autoFocus aria-label="自定义节奏预设名称" value={presetName} maxLength={40} onChange={event => setPresetName(event.target.value)} /></label><button className="dm-button dm-primary" disabled={!presetName.trim()} type="submit">保存</button><button type="button" className="dm-button" onClick={() => setSaveOpen(false)}>取消</button>{activePreset && <button type="button" className="dm-button" onClick={() => { stop(); setMachine(old => ({ ...old, selected: 'custom', presets: old.presets.filter(item => item.id !== old.selected) })); setSaveOpen(false); setCustom(true) }}><Trash2 size={15} />删除此预设</button>}</form>}
    {soundTarget && <div ref={editor} className="dm-sound-editor dm-panel" aria-label="音色设置"><div className="dm-section-heading"><h3>{soundTarget.kind === 'pad' ? `打击垫 ${PAD_KEYS[Number(soundTarget.id)]!.toUpperCase()} 音色` : '鼓轨音色'}</h3><p>从现有鼓音源中选择</p><button className="dm-button" aria-label="关闭音色设置" onClick={() => setSoundTarget(null)}><X size={16} /></button></div><div className="dm-sound-groups">{['全部', '底鼓', '军鼓', '踩镲', '通鼓', '镲片', '打击乐'].map(name => <button aria-pressed={soundGroup === name} key={name} onClick={() => setSoundGroup(name)}>{name}</button>)}</div><div className="dm-sound-list">{samples.filter(sample => soundGroup === '全部' || group(sample) === soundGroup).map(sample => <button key={sample.midiNote} aria-pressed={soundNote === sample.midiNote} onClick={() => {
      if (soundTarget.kind === 'pad') setMachine(old => ({ ...old, pads: old.pads.map((note, index) => index === soundTarget.id ? sample.midiNote : note) }))
      else changeDraft(old => ({ ...old, tracks: old.tracks.map(track => track.id === soundTarget.id ? { ...track, sample: sample.midiNote } : track) }))
      void engine.hit(sample, base, machine.velocity, draft.volume).catch(error => errorRef.current(String(error)))
    }}><Drum size={16} /><span>{sample.nameZh}</span>{soundNote === sample.midiNote && <small>已选</small>}</button>)}</div></div>}
    <div className="dm-bottom"><button onClick={onBack}><ArrowLeft size={14} />返回工具箱</button><span>{samples.length ? `${samples.length} 种鼓音色` : '正在读取音源…'} · 节奏与音色设置自动保存到本机</span></div>
  </section>
}
