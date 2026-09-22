import { allowAudioAction, useRecordingSession } from '../recording-session.js'
import { claimAudioSession, pauseAudioSession, releaseAudioSession } from '../audio-session.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, Drum, AudioLines, Music2 } from 'lucide-react'
import { EnsembleAudio } from './ensemble-audio.js'
import {
  DRUM_PRESETS,
  SYNTH_PRESETS,
  VIOLIN,
  applyWorkshopPreset,
  drumEvents,
  polyrhythmEvents,
  violinEvents,
  violinPositions,
  delayTimes,
  envelopeAt,
  type EnsemblePrefs,
  type LabEvent,
  type Workshop
} from './ensemble.js'
import { ROOTS, mod, noteName } from './theory.js'
import { NumberField, SelectField } from './Workbench.js'
import { Tuner } from './Tuner.js'
import { ViolinScore } from './ViolinScore.js'
import type { WoodshedAudio } from './audio.js'
import type { Preferences } from './types.js'
import './ensemble.css'
export function EnsembleWorkbench({
  visible = true,
  kind,
  p,
  onChange,
  audio,
  outputDeviceId,
  onError
}: {
  visible?: boolean
  kind: Exclude<Workshop, 'piano'>
  p: Preferences
  onChange: (patch: Partial<Preferences>) => void
  audio: WoodshedAudio | null
  outputDeviceId: string
  onError: (s: string) => void
}): React.JSX.Element {
  const [engine, setEngine] = useState<EnsembleAudio | null>(null),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false),
    [active, setActive] = useState<LabEvent | null>(null),
    [status, setStatus] = useState('准备好')
  const poly = p.ensemble.drum.mode,
    violinTool = p.ensemble.violin.tool
  const ticket = useRef(0),
    mounted = useRef(true)
  const sharedAudio = useRef(audio)
  sharedAudio.current = audio
  const recording = useRecordingSession()
  useEffect(() => { if (recording) { engine?.stop(); setPlaying(false); setBusy(false) } }, [Boolean(recording), engine])
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const session = useRef<number | undefined>(undefined)
  const releaseSession = (): void => { if (session.current !== undefined) releaseAudioSession('woodshed', session.current) }
  useEffect(() => {
    mounted.current = true
    const instance = new EnsembleAudio()
    setEngine(instance)
    return () => {
      mounted.current = false
      ticket.current++
      instance.destroy()
      releaseSession()
      sharedAudio.current?.stop()
    }
  }, [])
  useEffect(() => {
    void engine?.setOutput(outputDeviceId).catch((e) => onError(String(e)))
  }, [engine, outputDeviceId, onError])
  useEffect(() => { engine?.setVisualActive(visible) }, [engine, visible])
  const stop = (): void => {
    ticket.current++
    engine?.stop()
    releaseSession()
    audio?.stop()
    setPlaying(false)
    setBusy(false)
    setActive(null)
    setStatus('准备好')
  }
  useEffect(() => {
    stop()
  }, [p.ensemble, kind, poly, violinTool, p.a4])
  const update = <K extends keyof EnsemblePrefs>(key: K, value: Partial<EnsemblePrefs[K]>): void =>
    onChange({ ensemble: { ...p.ensemble, [key]: { ...p.ensemble[key], ...value } } })
  const d = p.ensemble.drum,
    v = p.ensemble.violin,
    s = p.ensemble.synth
  const drum = useMemo(
    () =>
      poly === 'grid' ? drumEvents(d.grid, d.swing) : polyrhythmEvents(poly === '3:2' ? 3 : 4, poly === '3:2' ? 2 : 3),
    [d.grid, d.swing, poly]
  )
  const violin = useMemo(() => violinEvents(v), [v])
  const positions = useMemo(() => violinPositions(v.root, v.scale), [v.root, v.scale])
  const preview = async (midi: number, synth = false): Promise<void> => {
    if (!allowAudioAction()) return
    pauseAudioSession()
    stop()
    const token = ticket.current
    try {
      await engine?.preview(midi, p.a4, synth ? s : undefined)
      if (mounted.current && token === ticket.current) setStatus(`试听 ${noteName(midi)}`)
    } catch (e) {
      if (mounted.current) onError(String(e))
    }
  }
  const play = async (events: LabEvent[], beats: number, bpm: number, rounds: number): Promise<void> => {
    if (!allowAudioAction()) return
    stop()
    setBusy(true)
    const token = ticket.current
    session.current = claimAudioSession('woodshed', kind === 'drums' ? '鼓手节奏' : kind === 'violin' ? '小提琴示范' : '合成器示范', stop)
    try {
      await engine?.play(
        events,
        beats,
        bpm,
        rounds,
        p.a4,
        (event, round, count) => {
          if (!visibleRef.current) return
          setActive(event)
          setStatus(count ? `预备拍 ${count} / 4` : `第 ${round} 轮${event?.bow ? ` · ${event.bow}` : ''}`)
        },
        () => {
          releaseSession()
          setPlaying(false)
          setActive(null)
          setStatus('本次示范结束')
        }
      )
      if (mounted.current && token === ticket.current) {
        setBusy(false)
        setPlaying(true)
      }
    } catch (e) {
      if (mounted.current && token === ticket.current) {
        releaseSession()
        setBusy(false)
        onError(String(e))
      }
    }
  }
  const transport = (events: LabEvent[], beats: number, bpm: number, rounds: number) => (
    <div className="ws-ensemble-transport">
      <button
        className="ws-button primary"
        disabled={!engine || busy || !events.length}
        onClick={() => (playing ? stop() : void play(events, beats, bpm, rounds))}
      >
        {playing ? <Square size={16} /> : <Play size={16} />} {busy ? '连接音频…' : playing ? '停止示范' : '播放示范'}
      </button>
      <span role="status">{status}</span>
      <small>四拍预备 · BPM = 四分音符 · 参数变化后停止，重新开始</small>
    </div>
  )
  const presetChange = (id: string) => onChange({ ensemble: applyWorkshopPreset(p.ensemble, kind, id) })
  return (
    <section
      className="ws-tool-panel ws-ensemble"
      aria-label={`${kind === 'drums' ? '鼓手' : kind === 'violin' ? '小提琴' : '合成器'}工作台`}
    >
      <div className="ws-panel-heading">
        <div>
          <small>
            {kind === 'drums' ? 'RHYTHM & COORDINATION' : kind === 'violin' ? 'BOW, PITCH & PHRASE' : 'BUILD A SOUND'}
          </small>
          <h2>{kind === 'drums' ? '鼓手节奏工作台' : kind === 'violin' ? '小提琴音准与运弓' : '合成器实验台'}</h2>
        </div>
        {kind === 'drums' ? <Drum /> : kind === 'violin' ? <Music2 /> : <AudioLines />}
      </div>
      {kind === 'drums' && (
        <>
          <p>
            每四格是一拍，16 格为一个 4/4 小节。点击循环：休止 → 普通击 → 重击。R / L 仅表示建议手序，不是自动动作检测。
          </p>
          <div className="ws-form-row">
            <SelectField
              label="节奏模式"
              value={poly}
              options={{ grid: '鼓组 / 基本手法', '3:2': '3:2 复节奏', '4:3': '4:3 复节奏' }}
              onChange={(mode) => update('drum', { mode: mode as typeof poly })}
            />
            {poly === 'grid' && (
              <SelectField
                label="鼓手预设"
                value={DRUM_PRESETS[d.preset] ? d.preset : 'custom'}
                options={{
                  ...Object.fromEntries(Object.entries(DRUM_PRESETS).map(([id, x]) => [id, x.name])),
                  custom: '自定义格子'
                }}
                onChange={presetChange}
              />
            )}
            <NumberField
              label="鼓手 BPM"
              value={d.bpm}
              min={30}
              max={200}
              onChange={(bpm) => update('drum', { bpm })}
            />
            <NumberField
              label="循环轮次（0 无限）"
              value={d.loops}
              min={0}
              max={16}
              onChange={(loops) => update('drum', { loops })}
            />
          </div>
          {poly === 'grid' ? (
            <>
              <label className="ws-ensemble-slider">
                八分长短比例：{Math.round(d.swing * 100)}%
                <input
                  aria-label="鼓手 Swing"
                  type="range"
                  min={50}
                  max={70}
                  value={d.swing * 100}
                  onChange={(e) => update('drum', { swing: Number(e.target.value) / 100 })}
                />
              </label>
              <div className="ws-drum-scroll">
                <div className="ws-drum-grid">
                  <span>声部</span>
                  {Array.from({ length: 16 }, (_, i) => (
                    <small key={i}>{i % 4 === 0 ? i / 4 + 1 : ['', 'e', '&', 'a'][i % 4]}</small>
                  ))}
                  {['底鼓', '军鼓', '闭镲'].map((label, lane) => (
                    <div className="ws-drum-row" key={label}>
                      <b>{label}</b>
                      {d.grid[lane]!.map((value, step) => (
                        <button
                          key={step}
                          aria-label={`${label} 第 ${step + 1} 格`}
                          aria-pressed={value > 0}
                          title={`${['休止', '普通击', '重击'][value]} · 点击切换`}
                          className={`hit-${value} ${active?.step === step ? 'playing' : ''} ${step % 4 === 0 ? 'beat-start' : ''}`}
                          onClick={() => {
                            const grid = d.grid.map((r) => [...r])
                            grid[lane]![step] = (value + 1) % 3
                            update('drum', { grid, preset: 'custom' })
                          }}
                        >
                          {value === 2 ? '›' : value === 1 ? '●' : '·'}
                        </button>
                      ))}
                    </div>
                  ))}
                  <span>手序</span>
                  {Array.from({ length: 16 }, (_, i) => (
                    <small key={i}>{DRUM_PRESETS[d.preset]?.sticking?.[i] ?? '—'}</small>
                  ))}
                </div>
              </div>
              <p className="ws-muted">
                普通击用于轻音参考，重击用于强调；真实幽灵音的力度由演奏者控制。Shuffle
                改变每拍前后半段的比例，格子宽度仍按记谱位置显示。
              </p>
            </>
          ) : (
            <>
              <div className="ws-poly-grid">
                {(poly === '3:2' ? [3, 2] : [4, 3]).map((n, lane) => (
                  <div key={n}>
                    <b>
                      {lane === 0 ? '军鼓' : '底鼓'} · {n} 等分
                    </b>
                    <div>
                      {Array.from({ length: poly === '3:2' ? 6 : 12 }, (_, i) => (
                        <span key={i} className={i % ((poly === '3:2' ? 6 : 12) / n) === 0 ? 'hit' : ''}>
                          {i + 1}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p>
                两层在同样四拍长度内分别均分，回到共同起点时重合。这里的 3:2 / 4:3 是两层同时进行，不能当作 Swing 比例。
              </p>
            </>
          )}
          {transport(drum, 4, d.bpm, d.loops)}
        </>
      )}
      {kind === 'violin' && (
        <>
          <div className="ws-track-tabs">
            {[
              ['fingerboard', '无品指板与运弓'],
              ['tuner', '小提琴调音'],
              ['drone', '空弦与双音参考']
            ].map(([id, name]) => (
              <button
                key={id}
                aria-pressed={violinTool === id}
                onClick={() => update('violin', { tool: id as typeof violinTool })}
              >
                {name}
              </button>
            ))}
          </div>
          {violinTool === 'tuner' ? (
            <Tuner
              visible={visible}
              tuning={VIOLIN}
              capo={0}
              a4={p.a4}
              onA4={(a4) => onChange({ a4 })}
              inputDevice={p.inputDevice}
              onDevice={(inputDevice) => onChange({ inputDevice })}
              audio={audio}
              onError={onError}
            />
          ) : violinTool === 'drone' ? (
            <>
              <p>
                先听标准空弦，再跟持续参考检查长音。参考采用所选 A4
                下的十二平均律；合奏中的纯五度与三度可按和声语境调整。
              </p>
              <div className="ws-form-row">
                {VIOLIN.notes.map((midi) => (
                  <button className="ws-button" key={midi} onClick={() => void preview(midi)}>
                    {noteName(midi)} 空弦
                  </button>
                ))}
                <SelectField
                  label="持续参考根音"
                  value={v.root}
                  options={Object.fromEntries(ROOTS.map((name, i) => [i, name]))}
                  onChange={(root) => update('violin', { root: Number(root) })}
                />
              </div>
              <button
                className="ws-button primary"
                onClick={() => {
                  if (!allowAudioAction()) return
                  stop()
                  const token = ticket.current
                  session.current = claimAudioSession('woodshed', '小提琴持续参考音', stop)
                  void audio
                    ?.drone(v.root, true)
                    .then(() => {
                      if (mounted.current && token === ticket.current) setStatus('根音 + 纯五度参考正在播放')
                    })
                    .catch((e) => { releaseSession(); onError(String(e)) })
                }}
              >
                播放根音 + 五度
              </button>
              <button className="ws-button" onClick={stop}>
                停止参考
              </button>
              <p role="status">{status}</p>
            </>
          ) : (
            <>
              <div className="ws-form-row">
                <SelectField
                  label="小提琴主音"
                  value={v.root}
                  options={Object.fromEntries(ROOTS.map((name, i) => [i, name]))}
                  onChange={(root) => update('violin', { root: Number(root) })}
                />
                <SelectField
                  label="小提琴音阶"
                  value={v.scale}
                  options={{ major: '大调', minor: '自然小调' }}
                  onChange={(scale) => update('violin', { scale: scale as 'major' | 'minor' })}
                />
                <SelectField
                  label="运弓音型"
                  value={v.pattern}
                  options={{ open: '空弦长弓', scale: '一八度音阶往返', cross: '相邻空弦换弦' }}
                  onChange={(pattern) => update('violin', { pattern: pattern as typeof v.pattern })}
                />
                <SelectField
                  label="起始空弦"
                  value={v.string}
                  options={Object.fromEntries(VIOLIN.notes.map((n, i) => [i, noteName(n)]))}
                  onChange={(string) => update('violin', { string: Number(string) })}
                />
              </div>
              <div className="ws-violin-board">
                <svg viewBox="0 0 850 310" role="group" aria-label="小提琴第一把位无品指板">
                  <rect x="125" y="30" width="670" height="235" rx="20" fill="var(--fretboard-surface)" />
                  {[...VIOLIN.notes].reverse().map((n, row) => (
                    <g key={n}>
                      <text x="30" y={65 + row * 57}>
                        {row + 1} 弦 · {noteName(n)}
                      </text>
                      <line
                        x1="125"
                        y1={60 + row * 57}
                        x2="795"
                        y2={60 + row * 57}
                        stroke="var(--fretboard-line)"
                        strokeWidth={1 + row * 0.45}
                      />
                    </g>
                  ))}
                  <line x1="150" y1="33" x2="150" y2="264" stroke="var(--score-ink)" strokeWidth="6" />
                  {positions.map((pos) => {
                    const x =
                        pos.offset === 0 ? 150 : 150 + (620 * (1 - 2 ** (-pos.offset / 12))) / (1 - 2 ** (-7 / 12)),
                      y = 60 + (3 - pos.string) * 57,
                      current = active?.midi === pos.midi && active?.string === pos.string
                    return (
                      <g
                        key={`${pos.string}-${pos.offset}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${4 - pos.string} 弦 ${pos.name} ${pos.finger} 指`}
                        onClick={() => void preview(pos.midi)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            void preview(pos.midi)
                          }
                        }}
                      >
                        <circle
                          cx={x}
                          cy={y}
                          r={current ? 23 : 20}
                          fill={current ? 'var(--danger)' : mod(pos.midi) === v.root ? 'var(--accent)' : 'var(--surface-raised)'}
                        />
                        <text
                          x={x}
                          y={y - 1}
                          textAnchor="middle"
                          fill={current || mod(pos.midi) === v.root ? 'var(--on-accent)' : 'var(--ink)'}
                          fontSize="12"
                        >
                          {pos.name.replace(/\d$/, '')}
                        </text>
                        <text
                          x={x}
                          y={y + 13}
                          textAnchor="middle"
                          fill={current || mod(pos.midi) === v.root ? 'var(--on-accent)' : 'var(--ink)'}
                          fontSize="9"
                        >
                          {pos.finger}
                        </text>
                      </g>
                    )
                  })}
                </svg>
              </div>
              <p className="ws-muted">
                第一把位 · 0 = 空弦，低 /
                高指相对常用手指框架。金色为主音，橙色为当前音。位置按有效弦长比例示意，不是品格或实物指距；以听觉校准。音阶换弦优先使用上一弦四指。
              </p>
              <div className="ws-form-row">
                <NumberField
                  label="运弓 BPM"
                  value={v.bpm}
                  min={30}
                  max={120}
                  onChange={(bpm) => update('violin', { bpm })}
                />
                <SelectField
                  label="每音 / 每弓拍数"
                  value={v.bowBeats}
                  options={{ 1: '1 拍', 2: '2 拍', 4: '4 拍' }}
                  onChange={(bowBeats) => update('violin', { bowBeats: Number(bowBeats) as 1 | 2 | 4 })}
                />
              </div>
              <div className="ws-bow-cue">
                <b>{active?.bow ?? '下弓 / 上弓'}</b>
                <span>{active?.midi ? noteName(active.midi) : '跟随每个音的起点换弓'}</span>
                <small>弓根 → 弓尖为下弓；弓尖 → 弓根为上弓。合成音用于音高与时长参考。</small>
              </div>
              <ViolinScore events={violin} active={active?.step ?? -1} />
              {transport(
                violin,
                violin.reduce((sum, e) => sum + e.duration, 0),
                v.bpm,
                2
              )}
            </>
          )}
        </>
      )}
      {kind === 'synthesis' && (
        <>
          <p>
            单音减法合成：振荡器 → 低通滤波器 → 音量 ADSR → 输出。LFO
            调制音高。点击键盘重新触发，参数改变后停止旧音；以下试听不包含 FM、波表或效果器。
          </p>
          <div className="ws-form-row">
            <SelectField
              label="合成器预设"
              value=""
              options={{
                '': '选择起始音色',
                ...Object.fromEntries(Object.entries(SYNTH_PRESETS).map(([id, x]) => [id, x.name]))
              }}
              onChange={presetChange}
            />
            <SelectField
              label="振荡器波形"
              value={s.wave}
              options={{ sine: '正弦', triangle: '三角', sawtooth: '锯齿', square: '方波' }}
              onChange={(wave) => update('synth', { wave: wave as typeof s.wave })}
            />
            <NumberField
              label="键盘八度"
              value={s.octave}
              min={2}
              max={5}
              onChange={(octave) => update('synth', { octave })}
            />
            <NumberField
              label="Gate 秒"
              value={s.gate}
              min={0.1}
              max={4}
              step={0.1}
              onChange={(gate) => update('synth', { gate })}
            />
          </div>
          <div className="ws-synth-diagrams">
            <div>
              <small>原始波形 · 两个周期示意</small>
              <svg viewBox="0 0 400 130" aria-label="原始波形">
                <line x1="0" y1="65" x2="400" y2="65" stroke="var(--border)" />
                <polyline
                  fill="none"
                  stroke="var(--success)"
                  strokeWidth="2"
                  points={Array.from({ length: 401 }, (_, i) => {
                    const phase = i / 200
                    const y =
                      s.wave === 'sine'
                        ? Math.sin(phase * Math.PI * 2)
                        : s.wave === 'square'
                          ? phase % 1 < 0.5
                            ? 1
                            : -1
                          : s.wave === 'sawtooth'
                            ? 2 * (phase % 1) - 1
                            : 1 - 4 * Math.abs((phase % 1) - 0.5)
                    return `${i},${65 - y * 48}`
                  }).join(' ')}
                />
              </svg>
            </div>
            <div>
              <small>
                音量包络 · Gate {s.gate}s / Release {s.release}s
              </small>
              <svg viewBox="0 0 400 130" aria-label="ADSR 包络">
                <line
                  x1={(s.gate / (s.gate + s.release)) * 400}
                  x2={(s.gate / (s.gate + s.release)) * 400}
                  y1="10"
                  y2="120"
                  stroke="var(--accent)"
                  strokeDasharray="4 4"
                />
                <polyline
                  fill="none"
                  stroke="var(--success)"
                  strokeWidth="2"
                  points={Array.from(
                    { length: 401 },
                    (_, i) => `${i},${115 - envelopeAt((i / 400) * (s.gate + s.release), s.gate, s) * 100}`
                  ).join(' ')}
                />
              </svg>
            </div>
          </div>
          <div className="ws-synth-controls">
            {(
              [
                ['cutoff', '低通截止 Hz', 80, 12000, 20],
                ['resonance', '共振 Q', 0.1, 12, 0.1],
                ['attack', 'Attack 秒', 0.01, 2, 0.01],
                ['decay', 'Decay 秒', 0.02, 2, 0.01],
                ['sustain', 'Sustain 电平', 0.05, 1, 0.01],
                ['release', 'Release 秒', 0.03, 3, 0.01],
                ['lfo', 'LFO 速率 Hz', 0, 12, 0.1],
                ['depth', 'LFO 音高深度 ±cents', 0, 100, 1]
              ] as const
            ).map(([key, label, min, max, step]) => (
              <label key={key}>
                {label}
                <b>{s[key]}</b>
                <input
                  aria-label={label}
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={s[key]}
                  onChange={(e) => update('synth', { [key]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <div className="ws-synth-keyboard" aria-label="合成器单音键盘">
            {Array.from({ length: 13 }, (_, i) => {
              const midi = (s.octave + 1) * 12 + i
              return (
                <button
                  key={i}
                  className={[1, 3, 6, 8, 10].includes(i) ? 'black' : 'white'}
                  onClick={() => void preview(midi, true)}
                >
                  {noteName(midi)}
                </button>
              )
            })}
          </div>
          <div className="ws-ensemble-transport">
            <button className="ws-button" onClick={stop}>
              <Square size={15} />
              停止声音
            </button>
            <span role="status">{status}</span>
          </div>
          <div className="ws-delay">
            <h3>节拍时间换算</h3>
            <NumberField
              label="同步 BPM"
              value={s.bpm}
              min={30}
              max={200}
              onChange={(bpm) => update('synth', { bpm })}
            />
            <dl>
              {Object.entries(delayTimes(s.bpm)).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    {
                      (
                        {
                          quarter: '四分音符',
                          eighth: '八分音符',
                          dottedEighth: '附点八分',
                          tripletEighth: '八分三连音',
                          sixteenth: '十六分音符'
                        } as Record<string, string>
                      )[key]
                    }
                  </dt>
                  <dd>{value.toFixed(2)} ms</dd>
                </div>
              ))}
            </dl>
            <p className="ws-muted">BPM 按四分音符计算。此处为 Delay / 调制同步的参数参考，试听本身没有加入延迟。</p>
          </div>
        </>
      )}
    </section>
  )
}
