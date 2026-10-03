import { WheelNumberInput } from '../components/WheelNumberInput.js'
import { createTempoWheel } from '../components/tempo-wheel.js'
import { useEffect, useId, useRef, useState } from 'react'
import { AudioLines, ChevronDown, Minus, Play, Plus, Settings, Square, Timer, X } from 'lucide-react'
import { clampBpm, MetronomeEngine, readMetronome, type MetronomeSettings, type MetronomePulse } from './metronome-engine.js'
import './metronome.css'

const marks = Array.from({ length: 33 }, (_, i) => {
  const angle = Math.PI * (1 - i / 32)
  const point = (r: number) => ({ x: 500 + r * Math.cos(angle), y: 478 - r * Math.sin(angle) })
  return { outer: point(400), inner: point(i % 8 === 0 ? 365 : 382) }
})
const tempoName = (bpm: number): string => bpm < 60 ? 'LARGO' : bpm < 76 ? 'ADAGIO' : bpm < 108 ? 'ANDANTE' : bpm < 121 ? 'MODERATO' : bpm < 168 ? 'ALLEGRO' : bpm < 200 ? 'VIVACE' : 'PRESTO'

export function Metronome({ outputDeviceId, onError }: { outputDeviceId: string; onError: (message: string) => void }): React.JSX.Element {
  const [config, setConfig] = useState(readMetronome)
  const [playing, setPlaying] = useState(false), [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<'settings' | 'meter' | null>(null)
  const [pulse, setPulse] = useState<MetronomePulse | null>(null)
  const [error, setError] = useState('')
  const [tapCount, setTapCount] = useState(0)
  const engine = useRef<MetronomeEngine | null>(null), rod = useRef<SVGGElement>(null)
  const knob = useRef<HTMLDivElement>(null), taps = useRef<number[]>([])
  const readout = useRef<SVGGElement>(null)
  const drag = useRef<{ x: number; y: number; bpm: number } | null>(null)
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null), repeats = useRef(0)
  const tapReset = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(false), desiredPlaying = useRef(false)
  const current = useRef(config); current.current = config
  const onErrorRef = useRef(onError); onErrorRef.current = onError
  const id = useId().replace(/:/g, '')
  const patch = (value: Partial<MetronomeSettings>): void => setConfig(old => ({ ...old, ...value }))
  const setBpm = (value: number): void => patch({ bpm: clampBpm(value) })
  const stopHold = (): void => { if (hold.current) clearTimeout(hold.current); hold.current = null }
  useEffect(() => {
    mounted.current = true
    engine.current = new MetronomeEngine()
    return () => { mounted.current = false; desiredPlaying.current = false; engine.current?.destroy(); stopHold(); if (tapReset.current) clearTimeout(tapReset.current) }
  }, [])
  useEffect(() => {
    void engine.current?.setOutput(outputDeviceId).catch(e => {
      engine.current?.stop(); desiredPlaying.current = false; setPlaying(false)
      setError('输出设备不可用'); onErrorRef.current(String(e))
    })
  }, [outputDeviceId])
  useEffect(() => {
    engine.current?.update(config)
    try { localStorage.setItem('bandbuddy.metronome.v1', JSON.stringify(config)) } catch { /* session remains usable */ }
  }, [config])
  useEffect(() => {
    const el = knob.current
    const display = readout.current
    const tempo = createTempoWheel()
    const wheel = (event: WheelEvent): void => {
      if (!event.deltaY) return
      event.preventDefault()
      event.stopPropagation()
      const delta = tempo.delta(event)
      setConfig(old => ({ ...old, bpm: clampBpm(old.bpm + delta) }))
    }
    el?.addEventListener('wheel', wheel, { passive: false })
    display?.addEventListener('wheel', wheel, { passive: false })
    el?.addEventListener('mouseleave', tempo.reset)
    display?.addEventListener('mouseleave', tempo.reset)
    return () => {
      el?.removeEventListener('wheel', wheel); display?.removeEventListener('wheel', wheel)
      el?.removeEventListener('mouseleave', tempo.reset); display?.removeEventListener('mouseleave', tempo.reset)
    }
  }, [])
  useEffect(() => {
    if (!playing) { setPulse(null); rod.current?.setAttribute('transform', 'rotate(0 500 478)'); return }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let animation = 0, last = -1
    const draw = (): void => {
      const audio = engine.current, frame = audio?.pulse()
      if (audio && frame) {
        if (frame.index !== last) { setPulse(frame); last = frame.index }
        const phase = Math.min(1, Math.max(0, (audio.now - frame.time) / frame.duration))
        const amplitude = 32 - (frame.bpm - 40) * 15 / 200
        const angle = reduced.matches ? 0 : Math.cos(phase * Math.PI) * amplitude * (frame.index % 2 ? 1 : -1)
        rod.current?.setAttribute('transform', `rotate(${angle} 500 478)`)
      }
      animation = requestAnimationFrame(draw)
    }
    animation = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animation)
  }, [playing])
  const toggle = async (): Promise<void> => {
    if (busy) return
    if (playing) { desiredPlaying.current = false; engine.current?.stop(); setPlaying(false); return }
    desiredPlaying.current = true; setBusy(true); setError('')
    try {
      const started = await engine.current?.start(current.current)
      if (mounted.current && desiredPlaying.current && started) setPlaying(true)
    } catch (e) {
      engine.current?.stop()
      if (mounted.current) { setError('无法启动音频输出'); onErrorRef.current(String(e)) }
    } finally { if (mounted.current) setBusy(false) }
  }
  const toggleRef = useRef(toggle); toggleRef.current = toggle
  const tap = (): void => {
    const now = performance.now()
    if (now - (taps.current.at(-1) ?? 0) > 2200) taps.current = []
    taps.current = [...taps.current.slice(-5), now]
    setTapCount(taps.current.length)
    if (tapReset.current) clearTimeout(tapReset.current)
    tapReset.current = setTimeout(() => setTapCount(0), 2200)
    if (taps.current.length > 1) setBpm(60000 * (taps.current.length - 1) / (now - taps.current[0]!))
  }
  const tapRef = useRef(tap); tapRef.current = tap
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPanel(null)
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input,select,textarea,button,[role="slider"],[contenteditable="true"]')) return
      if (e.code === 'Space') { e.preventDefault(); void toggleRef.current() }
      if (e.code === 'KeyT') { e.preventDefault(); tapRef.current() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const startHold = (direction: number): void => {
    stopHold(); repeats.current = 0
    const repeat = (): void => {
      repeats.current++
      setConfig(old => ({ ...old, bpm: clampBpm(old.bpm + direction * (repeats.current > 12 ? 5 : 1)) }))
      hold.current = setTimeout(repeat, 90)
    }
    hold.current = setTimeout(repeat, 400)
  }
  const bpm = pulse?.bpm ?? config.bpm
  return <section className="ws-metronome" aria-label="机械节拍器">
    <div className="metro-fasteners" aria-hidden="true"><i /><i /><i /><i /></div>
    <header className="metro-header">
      <div><small>LISTEN &amp; KEEP TIME</small><h2>节拍器</h2></div>
      <button className="metro-preset metro-button" aria-label="拍号" aria-expanded={panel === 'meter'} onClick={() => setPanel(panel === 'meter' ? null : 'meter')}><Timer /><span>{config.beats}/{config.denominator} · {bpm} BPM</span><ChevronDown size={18} /></button>
      <button className="metro-settings-button metro-button" aria-label="节拍器设置" aria-expanded={panel === 'settings'} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}><Settings /></button>
    </header>
    {panel && <div className="metro-settings" role="region" aria-label={panel === 'meter' ? '拍号设置' : '节拍器设置面板'}>
      <div className="metro-settings-heading"><strong>{panel === 'meter' ? '拍号' : '节奏与声音'}</strong><button aria-label="关闭设置" onClick={() => setPanel(null)}><X size={19} /></button></div>
      {panel === 'meter' ? <>
        <div className="metro-meters">{['2/4', '3/4', '4/4', '5/4', '6/8', '7/8'].map(meter => <button key={meter} aria-pressed={`${config.beats}/${config.denominator}` === meter} onClick={() => { const [beats, denominator] = meter.split('/').map(Number); patch({ beats, denominator }); setPanel(null) }}>{meter}</button>)}</div>
        <div className="metro-fields"><label>每小节拍数<input aria-label="每小节拍数" type="number" min={1} max={12} value={config.beats} onChange={e => patch({ beats: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} /></label><label>拍值<select value={config.denominator} onChange={e => patch({ denominator: Number(e.target.value) })}>{[2, 4, 8, 16].map(n => <option key={n} value={n}>1/{n} 音符</option>)}</select></label></div>
        <p>BPM 对应拍号分母的音符；6/8 每小节走六拍。</p>
      </> : <>
        <div className="metro-fields">
          <label>速度 BPM<WheelNumberInput onWheelValue={setBpm} type="number" min={30} max={240} value={config.bpm} onChange={e => setBpm(Number(e.target.value) || 30)} /></label>
          <label>细分<select value={config.subdivision} onChange={e => patch({ subdivision: Number(e.target.value) })}>{['每拍一次', '二等分', '三连音', '四等分'].map((text, i) => <option key={text} value={i + 1}>{text}</option>)}</select></label>
          <label>声音<select value={config.sound} onChange={e => patch({ sound: e.target.value as MetronomeSettings['sound'] })}><option value="wood">木质 · Wood</option><option value="click">清脆 · Click</option><option value="bell">铃声 · Bell</option></select></label>
          <label>预备拍<select value={config.countIn} onChange={e => patch({ countIn: Number(e.target.value) })}>{[0, 1, 2, 4].map(n => <option key={n} value={n}>{n ? `${n} 小节` : '关闭'}</option>)}</select></label>
          <label>自动加速<select value={config.speedStep} onChange={e => patch({ speedStep: Number(e.target.value) })}>{[0, 1, 2, 5, 10].map(n => <option key={n} value={n}>{n ? `每 4 小节 +${n} BPM` : '关闭'}</option>)}</select></label>
          <label>静音训练<select value={config.silentBars} onChange={e => patch({ silentBars: Number(e.target.value) })}>{[0, 1, 2, 4, 8].map(n => <option key={n} value={n}>{n ? `响 1 小节 / 静音 ${n} 小节` : '关闭'}</option>)}</select></label>
        </div>
        <label className="metro-accent"><input type="checkbox" checked={config.accent} onChange={e => patch({ accent: e.target.checked })} />第一拍重音</label>
        <label className="metro-volume">音量 <input aria-label="节拍器输出音量" type="range" min="0" max="1" step="0.01" value={config.volume} onChange={e => patch({ volume: Number(e.target.value) })} /><span>{Math.round(config.volume * 100)}%</span></label>
        <p>旋钮拖动 / 悬停滚轮调速，快滚加速 · 空格启停 · T 打拍</p>
      </>}
    </div>}
    <div className="metro-gauge">
      <svg viewBox="0 0 1000 530" role="img" aria-label={`${bpm} BPM，${tempoName(bpm)}`}>
        <defs>
          <linearGradient id={`${id}-rim`} x2="0.3" y2="1"><stop stopColor="var(--ink)" /><stop offset=".18" stopColor="var(--border-strong)" /><stop offset=".35" stopColor="var(--surface)" /><stop offset=".5" stopColor="var(--muted)" /><stop offset=".8" stopColor="var(--surface-muted)" /><stop offset="1" stopColor="var(--surface-raised)" /></linearGradient>
          <radialGradient id={`${id}-face`} cx="48%" cy="60%" r="70%"><stop stopColor="var(--surface-raised)" /><stop offset=".8" stopColor="var(--surface)" /><stop offset="1" stopColor="var(--border)" /></radialGradient>
          <linearGradient id={`${id}-metal`}><stop stopColor="var(--muted)" /><stop offset=".17" stopColor="var(--surface)" /><stop offset=".45" stopColor="var(--accent)" /><stop offset=".65" stopColor="var(--surface-muted)" /><stop offset="1" stopColor="var(--muted)" /></linearGradient>
          <linearGradient id={`${id}-rod`}><stop stopColor="var(--ink)" /><stop offset=".4" stopColor="var(--border-strong)" /><stop offset=".6" stopColor="var(--muted)" /><stop offset="1" stopColor="var(--ink)" /></linearGradient>
          <linearGradient id={`${id}-glass`} x2=".8" y2="1"><stop stopColor="var(--surface-raised)" stopOpacity=".6" /><stop offset=".4" stopColor="var(--surface-raised)" stopOpacity=".04" /><stop offset=".75" stopColor="var(--surface-raised)" stopOpacity="0" /><stop offset="1" stopColor="var(--surface-raised)" stopOpacity=".22" /></linearGradient>
          <filter id={`${id}-shadow`} x="-100%" width="300%" y="-30%" height="180%"><feDropShadow dx="6" dy="8" stdDeviation="5" floodColor="var(--ink)" floodOpacity=".3" /></filter>
        </defs>
        <path d="M 20 478 A 480 465 0 0 1 980 478 Q 980 513 953 513 H 47 Q 20 513 20 478" fill={`url(#${id}-rim)`} stroke="var(--border-strong)" strokeWidth="3" />
        <path d="M 25 478 A 475 460 0 0 1 975 478 Q 975 508 950 508 H 50 Q 25 508 25 478" fill="none" stroke="var(--ink)" strokeWidth="5" />
        <path d="M 31 478 A 469 453 0 0 1 969 478 Q 969 502 948 502 H 52 Q 31 502 31 478" fill="none" stroke="var(--surface)" strokeWidth="3" />
        <path d="M 38 476 A 462 445 0 0 1 962 476 Q 962 497 945 497 H 55 Q 38 497 38 476" fill={`url(#${id}-face)`} stroke="var(--surface-raised)" strokeWidth="4" />
        <path d="M 100 478 A 400 400 0 0 1 900 478" fill="none" stroke="var(--border)" strokeWidth="9" opacity=".48" />
        <path d="M 455 81 A 400 400 0 0 1 545 81" fill="none" stroke="var(--accent)" strokeWidth="12" opacity=".32" />
        {marks.map(({ outer, inner }, i) => <line key={i} x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke={i === 16 ? 'var(--accent)' : 'var(--muted)'} opacity={i % 8 ? 0.5 : 1} strokeWidth={i % 8 ? 1.2 : 3} strokeLinecap="round" />)}
        <g className="metro-scale" textAnchor="middle"><text x="75" y="485">40</text><text x="183" y="187">60</text><text x="500" y="62">120</text><text x="816" y="187">180</text><text x="929" y="485">200</text></g>
        <g ref={rod} filter={`url(#${id}-shadow)`}>
          <rect x="496" y="105" width="8" height="372" rx="4" fill={`url(#${id}-rod)`} stroke="var(--ink)" />
          <rect x="473" y="345" width="54" height="66" rx="6" fill={`url(#${id}-metal)`} stroke="var(--border-strong)" strokeWidth="2" />
          <path d="M 477 353 H 523 M 477 402 H 523" stroke="var(--surface-raised)" opacity=".65" /><path d="M 474 377 H 526" stroke="var(--muted)" opacity=".5" />
        </g>
        <g ref={readout} textAnchor="middle" className="metro-readout"><text className="metro-bpm" x="500" y="244">{bpm}</text><text className="metro-unit" x="504" y="282">BPM</text><text className="metro-tempo" x="500" y="318">{tempoName(bpm)}</text></g>
        <circle cx="500" cy="478" r="34" fill="var(--ink)" stroke="var(--border)" strokeWidth="3" /><circle cx="500" cy="478" r="28" fill={`url(#${id}-metal)`} stroke="var(--surface)" strokeWidth="2" />
        <path d="M 40 476 A 460 443 0 0 1 960 476 Q 960 495 945 495 H 55 Q 40 495 40 476" fill={`url(#${id}-glass)`} pointerEvents="none" />
      </svg>
    </div>
    <div className="metro-beats" aria-label="拍点指示">{Array.from({ length: config.beats }, (_, i) => <div key={i} className={`${pulse?.beat === i ? 'lit' : ''} ${i === 0 && config.accent ? 'accent' : ''}`} aria-label={`第 ${i + 1} 拍${pulse?.beat === i ? '，当前拍' : ''}`}><i /><span>{i + 1}</span></div>)}</div>
    <div className="metro-controls">
      <button className="metro-button metro-tap" onClick={tap} aria-label="TAP 设置速度">TAP</button>
      <div className="metro-encoder">
        {[-1, 1].map(direction => <button key={direction} className={`metro-step ${direction < 0 ? 'minus' : 'plus'}`} aria-label={direction < 0 ? '降低速度' : '提高速度'} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); startHold(direction) }} onPointerUp={stopHold} onPointerCancel={stopHold} onLostPointerCapture={stopHold} onClick={e => { if (!repeats.current || e.detail === 0) setBpm(current.current.bpm + direction * (e.shiftKey ? 5 : 1)); repeats.current = 0 }}>{direction < 0 ? <Minus /> : <Plus />}</button>)}
        <div className="metro-knob" ref={knob} role="slider" tabIndex={0} aria-label="速度旋钮" aria-valuemin={30} aria-valuemax={240} aria-valuenow={config.bpm} aria-valuetext={`${config.bpm} BPM`} title="上下或左右拖动、滚轮调速，方向键微调"
          onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, bpm: config.bpm }; e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus() }}
          onPointerMove={e => { if (drag.current) setBpm(drag.current.bpm + (e.clientX - drag.current.x + drag.current.y - e.clientY) / 3) }}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
          onKeyDown={e => { const direction = ['ArrowUp', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowDown', 'ArrowLeft'].includes(e.key) ? -1 : 0; if (direction) { e.preventDefault(); setBpm(config.bpm + direction * (e.shiftKey ? 5 : 1)) } if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setBpm(e.key === 'Home' ? 30 : 240) } }}>
          <i style={{ transform: `rotate(${(config.bpm - 120) * 1.2}deg)` }} />
        </div><span className="metro-knob-label">BPM</span>
      </div>
      <button className={`metro-button metro-start ${playing ? 'running' : ''}`} onClick={() => void toggle()} disabled={busy}>{playing ? <Square fill="currentColor" /> : <Play fill="currentColor" />} {busy ? '启动中' : playing ? '停止' : '开始'}</button>
    </div>
    <footer className="metro-footer"><div><i className={playing && !pulse?.silent && config.volume > 0 ? 'active' : ''} /><span>{error || (playing ? pulse?.countIn ? '预备拍' : pulse?.silent ? '静音训练中' : config.volume === 0 ? '音量已静音' : '节拍输出中' : '节拍器已就绪')}</span><div className="metro-level" aria-hidden="true"><span style={{ width: `${config.volume * 100}%` }} /></div><AudioLines /></div><p>{tapCount ? tapCount === 1 ? '继续点击 TAP，设定速度' : `已采集 ${tapCount} 次打拍 · ${config.bpm} BPM` : playing ? `${config.beats}/${config.denominator} · 点击停止，或按空格键` : '点击开始，或使用 TAP 设定速度'}</p></footer>
  </section>
}
