import { allowAudioAction, useRecordingSession } from '../recording-session.js'
import { claimAudioSession, pauseAudioSession, releaseAudioSession } from '../audio-session.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Piano, Play, Square, Volume2, RotateCcw } from 'lucide-react'
import { EnsembleAudio } from './ensemble-audio.js'
import { PianoScore } from './PianoScore.js'
import {
  keyboardLayout,
  pianoExercise,
  pianoDefaults,
  pianoSpelling,
  PIANO_PATTERNS,
  type PianoConfig,
  type PianoEvent
} from './piano.js'
import { ROOTS, SCALES, CHORDS, mod, noteName } from './theory.js'
import { SelectField, NumberField } from './Workbench.js'
import './piano.css'
export function PianoWorkbench({
  visible = true,
  config: c,
  onChange,
  outputDeviceId,
  a4,
  onError
}: {
  visible?: boolean
  config: PianoConfig
  onChange: (value: PianoConfig) => void
  outputDeviceId: string
  a4: number
  onError: (s: string) => void
}): React.JSX.Element {
  const [audio, setAudio] = useState<EnsembleAudio | null>(null),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false),
    [active, setActive] = useState<PianoEvent | null>(null),
    [status, setStatus] = useState('准备好'),
    [chosen, setChosen] = useState<number[]>([]),
    [collect, setCollect] = useState(false)
  const token = useRef(0),
    mounted = useRef(true)
  const recording = useRecordingSession()
  useEffect(() => { if (recording) { audio?.stop(); setPlaying(false); setBusy(false) } }, [Boolean(recording), audio])
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const session = useRef<number | undefined>(undefined)
  const releaseSession = (): void => { if (session.current !== undefined) releaseAudioSession('woodshed', session.current) }
  useEffect(() => {
    mounted.current = true
    const engine = new EnsembleAudio()
    setAudio(engine)
    return () => {
      mounted.current = false
      token.current++
      engine.destroy()
      releaseSession()
    }
  }, [])
  useEffect(() => {
    void audio?.setOutput(outputDeviceId).catch((e) => onError(String(e)))
  }, [audio, outputDeviceId, onError])
  useEffect(() => { audio?.setVisualActive(visible) }, [audio, visible])
  const stop = () => {
    token.current++
    audio?.stop()
    releaseSession()
    setPlaying(false)
    setBusy(false)
    setActive(null)
    setStatus('准备好')
  }
  useEffect(() => {
    stop()
    setChosen([])
  }, [c, a4])
  const patch = (p: Partial<PianoConfig>) => onChange({ ...c, ...p })
  const exercise = useMemo(() => pianoExercise(c), [c])
  const material = ['five', 'scale', 'contrary'].includes(c.pattern) ? SCALES[c.scale]! : CHORDS[c.chord]!
  const low = Math.floor(Math.min(c.octave * 12, ...exercise.events.flatMap((e) => e.pitches)) / 12) * 12,
    high = Math.ceil(Math.max((c.octave + 2) * 12, ...exercise.events.flatMap((e) => e.pitches)) / 12) * 12
  const keys = useMemo(() => keyboardLayout(low, high), [low, high]),
    whiteCount = keys.filter((k) => !k.black).length
  const preview = async (pitches: number[]) => {
    if (!allowAudioAction()) return
    pauseAudioSession()
    stop()
    setChosen(pitches)
    const ticket = token.current
    try {
      await audio?.previewChord(pitches, a4)
      if (mounted.current && ticket === token.current) setStatus(pitches.map((n) => noteName(n)).join(' · '))
    } catch (e) {
      if (mounted.current) onError(String(e))
    }
  }
  const click = (midi: number) =>
    collect
      ? setChosen((old) => (old.includes(midi) ? old.filter((n) => n !== midi) : [...old, midi].sort((a, b) => a - b)))
      : void preview([midi])
  const play = async () => {
    if (!allowAudioAction()) return
    stop()
    setChosen([])
    setBusy(true)
    const ticket = token.current
    session.current = claimAudioSession('woodshed', '钢琴示范', stop)
    try {
      await audio?.play(
        exercise.events,
        exercise.beats,
        c.bpm,
        c.rounds,
        a4,
        (e, round, count) => {
          if (!visibleRef.current) return
          setActive(e as PianoEvent | null)
          setStatus(count ? `预备拍 ${count} / 4` : `第 ${round} 轮 · 第 ${Math.floor((e?.beat ?? 0) / 4) + 1} 小节`)
        },
        () => {
          releaseSession()
          setPlaying(false)
          setActive(null)
          setStatus('示范结束')
        }
      )
      if (mounted.current && ticket === token.current) {
        setBusy(false)
        setPlaying(true)
      }
    } catch (e) {
      if (mounted.current && ticket === token.current) {
        releaseSession()
        setBusy(false)
        onError(String(e))
      }
    }
  }
  return (
    <section className="ws-tool-panel ws-piano" aria-label="键盘钢琴工作台">
      <div className="ws-panel-heading">
        <div>
          <small>KEYS, HANDS & HARMONY</small>
          <h2>键盘／钢琴工作台</h2>
        </div>
        <Piano size={25} />
      </div>
      <p>看清两手的音位、和声与节奏。键盘、大谱表和示范声音来自相同音符事件；声音为本地合成参考。</p>
      <div className="ws-piano-fields">
        <SelectField
          label="钢琴主音"
          value={c.root}
          options={Object.fromEntries(ROOTS.map((n, i) => [i, n]))}
          onChange={(root) => patch({ root: Number(root) })}
        />
        <SelectField
          label="钢琴音型"
          value={c.pattern}
          options={PIANO_PATTERNS}
          onChange={(pattern) =>
            patch({
              pattern: pattern as PianoConfig['pattern'],
              ...(pattern === 'alberti' && !['major', 'minor', 'dim'].includes(c.chord)
                ? { chord: 'major' as const, inversion: 0 }
                : {})
            })
          }
        />
        <SelectField
          label="演奏声部"
          value={c.hands}
          options={{ both: '双手', right: '右手', left: '左手' }}
          onChange={(hands) => patch({ hands: hands as PianoConfig['hands'] })}
        />
        <NumberField label="右手主音八度" value={c.octave} min={3} max={4} onChange={(octave) => patch({ octave })} />
        {['five', 'scale', 'contrary'].includes(c.pattern) ? (
          <SelectField
            label="钢琴音阶"
            value={c.scale}
            options={{ major: '大调', minor: '自然小调', harmonic: '和声小调' }}
            onChange={(scale) => patch({ scale: scale as PianoConfig['scale'] })}
          />
        ) : ['chord', 'arpeggio', 'alberti'].includes(c.pattern) ? (
          <>
            <SelectField
              label="钢琴和弦性质"
              value={c.chord}
              options={{
                major: '大三和弦',
                minor: '小三和弦',
                ...(c.pattern === 'alberti' ? {} : { '7': '属七和弦', maj7: '大七和弦', m7: '小七和弦' }),
                dim: '减三和弦'
              }}
              onChange={(chord) => patch({ chord: chord as PianoConfig['chord'], inversion: 0 })}
            />
            <SelectField
              label="钢琴和弦转位"
              value={mod(c.inversion, CHORDS[c.chord]!.semitones.length)}
              options={Object.fromEntries(
                CHORDS[c.chord]!.semitones.map((_, i) => [i, ['原位', '第一转位', '第二转位', '第三转位'][i]!])
              )}
              onChange={(inversion) => patch({ inversion: Number(inversion) })}
            />
          </>
        ) : (
          <span className="ws-tag">每小节一和弦 · 右手优先平稳连接</span>
        )}
        <NumberField label="钢琴 BPM" value={c.bpm} min={30} max={160} onChange={(bpm) => patch({ bpm })} />
        <NumberField
          label="钢琴轮次（0 无限）"
          value={c.rounds}
          min={0}
          max={8}
          onChange={(rounds) => patch({ rounds })}
        />
      </div>
      <div className="ws-piano-key-actions">
        <SelectField
          label="键盘标签"
          value={c.labels}
          options={{ notes: '音名', degrees: '音级 / 和弦音程', none: '隐藏标签' }}
          onChange={(labels) => patch({ labels: labels as PianoConfig['labels'] })}
        />
        <label>
          <input
            type="checkbox"
            checked={collect}
            onChange={(e) => {
              stop()
              setChosen([])
              setCollect(e.target.checked)
            }}
          />
          选音组成和弦
        </label>
        <button className="ws-button" disabled={!audio || !chosen.length} onClick={() => void preview(chosen)}>
          <Volume2 size={14} />
          试听所选 {chosen.length} 音
        </button>
        <button
          className="ws-button"
          onClick={() => {
            stop()
            setChosen([])
          }}
        >
          清空选音
        </button>
      </div>
      <div className="ws-piano-key-scroll">
        <svg
          viewBox={`0 0 ${whiteCount * 46} 210`}
          style={{ minWidth: Math.max(680, whiteCount * 37) }}
          role="group"
          aria-label="交互钢琴键盘"
        >
          {[...keys]
            .sort((a, b) => Number(a.black) - Number(b.black))
            .map((k) => {
              const right = active?.right.includes(k.midi),
                left = active?.left.includes(k.midi),
                selected = chosen.includes(k.midi),
                root = mod(k.midi) === c.root,
                index = material.semitones.findIndex((s) => mod(s) === mod(k.midi - c.root)),
                label =
                  c.labels === 'none'
                    ? ''
                    : c.labels === 'notes'
                      ? pianoSpelling(k.midi, c.root, material)
                      : (material.degrees[index] ?? '')
              return (
                <g
                  key={k.midi}
                  role="button"
                  tabIndex={0}
                  aria-label={`琴键 ${noteName(k.midi)}`}
                  aria-pressed={selected}
                  onClick={() => click(k.midi)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      click(k.midi)
                    }
                  }}
                >
                  <rect
                    x={k.x * 46 + 1}
                    y="1"
                    width={k.width * 46 - 2}
                    height={k.black ? 126 : 202}
                    rx="4"
                    fill={
                      selected
                        ? 'var(--danger)'
                        : right && left
                          ? 'var(--purple)'
                          : right
                            ? 'var(--success)'
                            : left
                              ? 'var(--accent)'
                              : k.black
                                ? 'var(--piano-black)'
                                : 'var(--piano-white)'
                    }
                    stroke="var(--border-strong)"
                  />
                  <text
                    x={(k.x + k.width / 2) * 46}
                    y={k.black ? 107 : 176}
                    textAnchor="middle"
                    fontSize="10"
                    fill={right || left || selected ? 'var(--on-accent)' : k.black ? 'var(--inverse-text)' : 'var(--piano-black)'}
                  >
                    {label}
                  </text>
                  {root && (
                    <circle
                      cx={(k.x + k.width / 2) * 46}
                      cy={k.black ? 84 : 193}
                      r="3"
                      fill={k.black ? 'var(--inverse-text)' : 'var(--accent)'}
                    />
                  )}
                </g>
              )
            })}
        </svg>
      </div>
      <div className="ws-piano-legend">
        <span>● 左手：金色</span>
        <span>● 右手：绿色</span>
        <span>● 双手同音：紫色</span>
        <span>● 手动选音：橙色</span>
        <span>小圆点：当前主音</span>
      </div>
      <div className="ws-piano-note-strip">
        <b>{active?.harmony ?? '本次参考音型'}</b>
        <span>
          左手：{active?.left.map((n) => noteName(n)).join(' · ') || '—'}
          {active?.fingers && c.hands !== 'right' ? `（${active.fingers.left} 指）` : ''}
        </span>
        <span>
          右手：{active?.right.map((n) => noteName(n)).join(' · ') || '—'}
          {active?.fingers && c.hands !== 'left' ? `（${active.fingers.right} 指）` : ''}
        </span>
      </div>
      <p className="ws-muted">
        指号仅提示 C 大调同向音阶和五指型，其余调需按手型重新规划。数字 1
        均为拇指。蓝调与流行进行会随小节更换和弦；键盘标签作为静态观察，播放时以谱面及当前和声为准。反向练习两手从同一主音出发。
      </p>
      {exercise.events.some((e) => e.harmony) && (
        <div className="ws-piano-changes">
          {exercise.events
            .filter((e) => e.harmony)
            .map((e) => (
              <button
                key={e.step}
                className={active?.step === e.step ? 'active' : ''}
                onClick={() => void preview(e.pitches)}
              >
                <small>第 {Math.floor(e.beat / 4) + 1} 小节</small>
                {e.harmony}
              </button>
            ))}
        </div>
      )}
      <PianoScore events={exercise.events} active={active?.step ?? -1} />
      <div className="ws-ensemble-transport">
        <button
          className="ws-button primary"
          disabled={!audio || busy}
          onClick={() => (playing ? stop() : void play())}
        >
          {playing ? <Square size={15} /> : <Play size={15} />}{' '}
          {busy ? '连接音频…' : playing ? '停止钢琴示范' : '播放钢琴示范'}
        </button>
        <span role="status">{status}</span>
        <small>四拍预备 · BPM = 四分音符 · 分手后空缺声部显示休止</small>
        <button className="ws-button" onClick={() => onChange(pianoDefaults())}>
          <RotateCcw size={14} />
          恢复钢琴参数
        </button>
      </div>
    </section>
  )
}
