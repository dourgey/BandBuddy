import { allowAudioAction, useRecordingSession } from '../recording-session.js'
import { claimAudioSession, pauseAudioSession, releaseAudioSession } from '../audio-session.js'
import { Select } from '../components/ui/Select.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, RotateCcw, Volume2, SlidersHorizontal } from 'lucide-react'
import { CHORDS, SCALES, ROOTS, materialNotes, chordVoicings, type Position, type Tuning } from './theory.js'
import { BACKINGS, beatUnit, generateExercise, progression, type GeneratedExercise } from './generator.js'
import { PATTERNS, type ExerciseConfig, type Preferences, type Technique } from './types.js'
import { Fretboard, ChordDiagram, legendLabel } from './Fretboard.js'
import { Score } from './Score.js'
import { IDLE_FRAME, type WoodshedAudio } from './audio.js'
import { guitarProjectExercise, projectConfig, type ElectricConfig, type GuitarProject } from './electric.js'
import { ElectricProjectIntro } from './ElectricProjects.js'
export function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string | number
  options: Record<string, string>
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <label className="ws-field">
      {label}
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(options).map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </Select>
    </label>
  )
}
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="ws-field">
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const value = Number(e.target.value)
          if (Number.isFinite(value)) onChange(Math.max(min, Math.min(max, Math.round(value / step) * step)))
        }}
      />
    </label>
  )
}
export function Workbench({
  visible = true,
  tuning,
  preferences,
  patch,
  onLabels,
  audio,
  onError,
  technique,
  project,
  onProjectSettings,
  metronomeOnly = false
}: {
  visible?: boolean
  tuning: Tuning
  preferences: Preferences
  patch: (p: Partial<ExerciseConfig>) => void
  onLabels: (s: Preferences['labels']) => void
  audio: WoodshedAudio | null
  onError: (s: string) => void
  technique?: Technique
  project?: GuitarProject
  onProjectSettings?: (value: ElectricConfig) => void
  metronomeOnly?: boolean
}): React.JSX.Element {
  const c = useMemo(
    () =>
      project
        ? projectConfig(project, preferences.exercise, preferences.electric, preferences.capo)
        : preferences.exercise,
    [project, preferences.exercise, preferences.electric, preferences.capo]
  )
  const [advanced, setAdvanced] = useState(false),
    [frame, setFrame] = useState({ ...IDLE_FRAME }),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Position[]>([])
  const root = useRef<HTMLDivElement>(null),
    tapTimes = useRef<number[]>([]),
    ticket = useRef(0),
    paused = useRef(false)
  const recording = useRecordingSession()
  useEffect(() => { if (recording) audio?.stop() }, [Boolean(recording), audio])
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const starting = useRef(false)
  const session = useRef<number | undefined>(undefined)
  const releaseSession = (): void => { if (session.current !== undefined) releaseAudioSession('woodshed', session.current) }
  const generated = useMemo(() => {
    try {
      return {
        data: project
          ? guitarProjectExercise(project, tuning, preferences.capo, preferences.electric)
          : generateExercise(tuning, preferences.capo, c, technique),
        error: ''
      }
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : '无法生成练习' }
    }
  }, [tuning, preferences.capo, preferences.electric, c, technique, project])
  const fallback: GeneratedExercise = useMemo(
    () => ({ events: [{ id: 'metronome', beat: 0, duration: 4, notes: [] }], beats: 12, bars: 3 }),
    []
  )
  const exercise = metronomeOnly ? fallback : generated.data
  useEffect(() => {
    audio?.onFrame(next => {
      if (visibleRef.current || !next.playing) setFrame(next)
      if (!next.playing && !starting.current) releaseSession()
    })
    return () => {
      audio?.onFrame(() => {})
      audio?.stop()
      releaseSession()
    }
  }, [audio])
  useEffect(() => {
    audio?.setVisualActive(visible)
    if (visible && audio) setFrame(audio.getFrame())
  }, [audio, visible])
  useEffect(() => {
    ticket.current++
    starting.current = false
    setBusy(false)
    paused.current = false
    audio?.stop()
    setSelected([])
  }, [c, tuning, preferences.capo, technique, audio])
  useEffect(() => {
    const el = root.current
    el?.querySelectorAll('[data-event].active').forEach((e) => e.classList.remove('active'))
    if (frame.eventId && !frame.hidden)
      el?.querySelector(`[data-event="${frame.eventId}"]`)?.classList.add('active')
  }, [frame.eventId, frame.hidden])
  const toggle = async (): Promise<void> => {
    if (!allowAudioAction()) return
    if (!audio || !exercise || busy) return
    if (frame.playing) {
      audio.pause()
      paused.current = true
      return
    }
    setBusy(true)
    const current = ++ticket.current
    starting.current = true
    session.current = claimAudioSession('woodshed', metronomeOnly ? '节拍器' : '练功房练习', () => { const pending = starting.current; starting.current = false; if (pending) audio.stop(); else audio.pause(); paused.current = !pending; ticket.current++; setBusy(false); releaseSession() })
    try {
      await audio.play(exercise, c, metronomeOnly, paused.current)
      if (current === ticket.current) paused.current = false
    } catch (e) {
      if (current === ticket.current) { releaseSession(); onError(e instanceof Error ? e.message : String(e)) }
    } finally {
      if (current === ticket.current) { starting.current = false; setBusy(false) }
    }
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    if (!visible) return
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (
        e.defaultPrevented ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.repeat ||
        target.closest(
          'input,select,textarea,button,[role="button"],[role="dialog"],[contenteditable="true"]'
        ) ||
        document.querySelector('[role="dialog"]')
      )
        return
      if (e.code === 'Space') {
        e.preventDefault()
        void toggleRef.current()
      }
      if (e.code === 'Home') {
        e.preventDefault()
        audio?.stop()
        paused.current = false
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [audio, visible])
  const preview = (p: Position): void => {
    if (!allowAudioAction()) return
    pauseAudioSession()
    setSelected([p])
    void audio?.preview(p.midi).catch((e) => onError(String(e)))
  }
  const active = frame.hidden
    ? []
    : (generated.data?.events.find((e) => e.id === frame.eventId)?.notes ?? selected)
  const harmony = progression(c.backing, c.root)[(frame.bar - 1) % progression(c.backing, c.root).length]!
  const displayConfig =
    c.mode === 'apply' && c.material === 'chord' && frame.playing && c.backing !== 'drone'
      ? { ...c, root: harmony.root, chord: harmony.quality }
      : c
  const displayPreferences = {
    ...preferences,
    exercise: frame.hidden ? { ...displayConfig, hint: 'none' as const } : displayConfig
  }
  const material = (c.material === 'chord' ? CHORDS[c.chord] : SCALES[c.scale])!
  const voicings = useMemo(
    () =>
      c.material === 'chord' ? chordVoicings(tuning, c.root, CHORDS[c.chord]!, preferences.capo, c) : [],
    [tuning, c.root, c.chord, c.material, c.minFret, c.maxFret, c.strings, preferences.capo]
  )
  const tap = (): void => {
    const now = performance.now()
    if (now - (tapTimes.current.at(-1) ?? 0) > 2200) tapTimes.current = []
    tapTimes.current = [...tapTimes.current.slice(-5), now]
    if (tapTimes.current.length >= 2) {
      const interval = (now - tapTimes.current[0]!) / (tapTimes.current.length - 1)
      patch({ bpm: Math.max(30, Math.min(240, Math.round(60000 / interval))) })
    }
  }
  return (
    <div ref={root} className="ws-workbench">
      <div className="ws-panel-heading">
        <div>
          <small>{metronomeOnly ? 'KEEP YOUR TIME' : 'EXPLORE · LISTEN · PRACTICE'}</small>
          <h2>{metronomeOnly ? '节拍器' : project ? '电吉他项目工作台' : '练习工作台'}</h2>
        </div>
        <button className="ws-button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          <SlidersHorizontal size={15} /> {advanced ? '收起参数' : '练习参数'}
        </button>
      </div>
      {project && onProjectSettings && (
        <ElectricProjectIntro
          project={project}
          settings={preferences.electric}
          onChange={onProjectSettings}
          bpm={c.bpm}
          onBpm={(bpm) => patch({ bpm })}
        />
      )}
      {!metronomeOnly && !project && (
        <div className="ws-material-controls">
          <SelectField
            label="主音"
            value={c.root}
            options={Object.fromEntries(ROOTS.map((n, i) => [i, n]))}
            onChange={(v) => patch({ root: Number(v) })}
          />
          <SelectField
            label="音乐材料"
            value={c.material}
            options={{ scale: '音阶', chord: '和弦 / 琶音' }}
            onChange={(v) => patch({ material: v as ExerciseConfig['material'] })}
          />
          <SelectField
            label={c.material === 'scale' ? '音阶' : '和弦性质'}
            value={c.material === 'scale' ? c.scale : c.chord}
            options={Object.fromEntries(
              Object.entries(c.material === 'scale' ? SCALES : CHORDS).map(([id, m]) => [id, m.name])
            )}
            onChange={(v) => patch(c.material === 'scale' ? { scale: v } : { chord: v })}
          />
          <SelectField
            label="练习音型"
            value={c.pattern}
            options={PATTERNS}
            onChange={(v) => patch({ pattern: v as ExerciseConfig['pattern'] })}
          />
        </div>
      )}
      {!metronomeOnly && (
        <>
          <div className="ws-note-strip">
            <b>
              {ROOTS[c.root]} · {material.name}
            </b>
            <span>{materialNotes(c.root, material).join('　')}</span>
            <small>{material.degrees.join(' · ')}</small>
          </div>
          {c.material === 'scale' && !project && (
            <div className="ws-overlay-chord">
              <SelectField
                label="叠加同主音和弦"
                value={c.chord}
                options={Object.fromEntries(
                  Object.entries(CHORDS).map(([id, m]) => [id, `${ROOTS[c.root]} · ${m.name}`])
                )}
                onChange={(chord) => patch({ chord })}
              />
              <small>绿色标记为所选和弦音；音阶材料保持不变。</small>
            </div>
          )}
          <div className="ws-fret-toolbar">
            <div className="ws-segments">
              {(
                [
                  ['notes', '音名'],
                  ['degrees', '音级'],
                  ['chord', '和弦音程']
                ] as const
              ).map(([id, name]) => (
                <button key={id} aria-pressed={preferences.labels === id} onClick={() => onLabels(id)}>
                  {name}
                </button>
              ))}
            </div>
            {!project && (
              <div className="ws-fret-range">
                <NumberField
                  label="起始品"
                  value={c.minFret}
                  min={0}
                  max={c.maxFret}
                  onChange={(v) => patch({ minFret: v })}
                />
                <NumberField
                  label="结束品"
                  value={c.maxFret}
                  min={c.minFret}
                  max={tuning.frets - preferences.capo}
                  onChange={(v) => patch({ maxFret: v })}
                />
                <button
                  className="ws-button"
                  onClick={() => patch({ minFret: 0, maxFret: tuning.frets - preferences.capo })}
                >
                  全指板
                </button>
              </div>
            )}
          </div>
          <Fretboard tuning={tuning} preferences={displayPreferences} active={active} onNote={preview} />
          <div className="ws-fret-legend">
            <span>
              <i className="root" /> 根音
            </span>
            <span>
              <i className="chord" /> 和弦音
            </span>
            <span>
              <i /> 其他音阶音
            </span>
            <span>
              <i className="current" /> 当前音
            </span>
            <small>{legendLabel(c)}</small>
          </div>
          {!project && (
            <div className="ws-string-filter">
              <span>限定弦组</span>
              {tuning.notes
                .map((_, i) => i + 1)
                .map((s) => (
                  <button
                    key={s}
                    aria-pressed={!c.strings.length || c.strings.includes(s)}
                    onClick={() => {
                      const list = c.strings.length
                        ? c.strings
                        : [...Array(tuning.notes.length)].map((_, i) => i + 1)
                      const next = list.includes(s) ? list.filter((n) => n !== s) : [...list, s]
                      patch({ strings: next })
                    }}
                  >
                    {s} 弦
                  </button>
                ))}
              <button onClick={() => patch({ strings: [] })}>全部</button>
            </div>
          )}
        </>
      )}
      {(advanced || metronomeOnly) && (
        <div className="ws-advanced">
          <NumberField
            label="速度 BPM"
            value={c.bpm}
            min={30}
            max={240}
            onChange={(v) => patch({ bpm: v })}
          />
          {!project && (
            <>
              <SelectField
                label="拍号"
                value={c.meter}
                options={{
                  '2/4': '2/4',
                  '3/4': '3/4',
                  '4/4': '4/4',
                  '6/8': '6/8',
                  '12/8': '12/8',
                  '7/8': '7/8'
                }}
                onChange={(v) => patch({ meter: v })}
              />
              <SelectField
                label="每大拍细分"
                value={c.subdivision}
                options={{ 1: '1 音', 2: '2 音', 3: '3 音', 4: '4 音' }}
                onChange={(v) => patch({ subdivision: Number(v) })}
              />
              <SelectField
                label="长短感"
                value={String(c.swing)}
                options={{
                  '0.5': 'Straight · 均分',
                  '0.6': 'Swing · 60%',
                  [String(2 / 3)]: 'Shuffle · 约 2:1',
                  '0.7': 'Swing · 70%'
                }}
                onChange={(v) => patch({ swing: Number(v) })}
              />
            </>
          )}
          <NumberField
            label="预备小节"
            value={c.countIn}
            min={0}
            max={2}
            onChange={(v) => patch({ countIn: v })}
          />
          <NumberField
            label="轮次（0 无限）"
            value={c.rounds}
            min={0}
            max={32}
            onChange={(v) => patch({ rounds: v })}
          />
          <NumberField
            label="每轮升速 BPM"
            value={c.speedStep}
            min={0}
            max={10}
            onChange={(v) => patch({ speedStep: v })}
          />
          <NumberField
            label="每响一小节后静音"
            value={c.silentBars}
            min={0}
            max={4}
            onChange={(v) => patch({ silentBars: v })}
          />
          {!metronomeOnly && (
            <>
              {!project && (
                <>
                  <SelectField
                    label="方向"
                    value={c.direction}
                    options={{ up: '上行', down: '下行', both: '往返' }}
                    onChange={(v) => patch({ direction: v as ExerciseConfig['direction'] })}
                  />
                  <SelectField
                    label="模进规则"
                    value={c.sequence}
                    options={{ diatonic: '调内 · 按音阶位置', chromatic: '精确 · 按半音' }}
                    onChange={(v) => patch({ sequence: v as ExerciseConfig['sequence'] })}
                  />
                  <NumberField
                    label={c.sequence === 'diatonic' ? '步长（音阶位置）' : '步长（半音）'}
                    value={c.step}
                    min={1}
                    max={12}
                    onChange={(v) => patch({ step: v })}
                  />
                </>
              )}
              <SelectField
                label="视觉提示"
                value={c.hint}
                options={{ all: '完整提示', roots: '只留根音', none: '完全隐藏' }}
                onChange={(v) => patch({ hint: v as ExerciseConfig['hint'] })}
              />
              <NumberField
                label="循环起始小节"
                value={c.loopStart}
                min={1}
                max={generated.data?.bars ?? 1}
                onChange={(v) => patch({ loopStart: v })}
              />
              <NumberField
                label="循环末小节（0 全部）"
                value={c.loopEnd}
                min={0}
                max={generated.data?.bars ?? 1}
                onChange={(v) => patch({ loopEnd: v })}
              />
            </>
          )}
          {!project && (
            <label className="ws-check">
              <input
                type="checkbox"
                checked={c.backbeat}
                onChange={(e) => patch({ backbeat: e.target.checked })}
              />
              只提示第 2、4 大拍
            </label>
          )}
          <p className="ws-muted">
            {beatUnit(c.meter) === 1.5 ? 'BPM 以附点四分音符为一拍。' : 'BPM 以四分音符为一拍。'}
            长短感只改变二等分。静音小节同时隐藏拍点与谱面游标。
          </p>
        </div>
      )}
      <div className="ws-transport">
        <div className="ws-play-buttons">
          <button
            className="ws-play"
            disabled={!audio || !exercise || busy}
            onClick={() => void toggle()}
            aria-label={frame.playing ? '暂停练习' : '开始练习'}
          >
            {frame.playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button
            className="ws-icon-button"
            aria-label="重来"
            onClick={() => {
              audio?.stop()
              paused.current = false
            }}
          >
            <RotateCcw size={18} />
          </button>
          <div>
            <b>
              {frame.countIn
                ? `预备 · ${frame.countIn}`
                : frame.playing
                  ? frame.hidden
                    ? '保持内在拍点'
                    : `第 ${frame.round} 轮 · 第 ${frame.bar} 小节`
                  : '准备好，就开始'}
            </b>
            <small>
              {frame.hidden && frame.playing
                ? '内部拍点练习 · 提示已隐藏'
                : `${frame.playing ? frame.bpm : c.bpm} BPM · ${c.meter} · ${beatUnit(c.meter) === 1.5 ? '附点四分音符' : '四分音符'}为一拍`}
            </small>
          </div>
        </div>
        <div className="ws-transport-right">
          <button className="ws-button" onClick={tap}>
            Tap Tempo
          </button>
          {!metronomeOnly && (
            <div className="ws-segments">
              {(
                [
                  ['demo', '听示范'],
                  ['follow', '跟练'],
                  ['apply', '伴奏应用']
                ] as const
              ).map(([id, label]) => (
                <button key={id} aria-pressed={c.mode === id} onClick={() => patch({ mode: id })}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {project && c.mode === 'apply' && (
        <div className="ws-backing">
          <p>项目节奏底 · 保持 {c.meter}；按谱例自行演奏和声与旋律。</p>
          <label>
            鼓音量{' '}
            <input
              aria-label="项目鼓音量"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={c.drums}
              onChange={(e) => patch({ drums: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      {!metronomeOnly && !project && c.mode === 'apply' && (
        <div className="ws-backing">
          <div className="ws-backing-controls">
            <SelectField
              label="和声伴奏"
              value={c.backing}
              options={BACKINGS}
              onChange={(v) => patch({ backing: v })}
            />
            {(['drums', 'bass', 'harmony'] as const).map((key) => (
              <label key={key}>
                {{ drums: '鼓', bass: '低音', harmony: '和声' }[key]}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={c[key]}
                  onChange={(e) => patch({ [key]: Number(e.target.value) })}
                />
                <small>{Math.round(c[key] * 100)}%</small>
              </label>
            ))}
          </div>
          <div className="ws-progression">
            {progression(c.backing, c.root).map((bar, i) => (
              <div
                key={i}
                className={
                  frame.playing &&
                  !frame.hidden &&
                  (frame.bar - 1) % progression(c.backing, c.root).length === i
                    ? 'active'
                    : ''
                }
              >
                <small>{i + 1}</small>
                <b>
                  {ROOTS[bar.root]}
                  {bar.quality === 'major' ? '' : bar.quality === 'minor' ? 'm' : bar.quality}
                </b>
                <span>{bar.numeral}</span>
              </div>
            ))}
          </div>
          <p className="ws-muted">
            本地合成伴奏 · 跟练和应用模式由你演奏主旋律，不自动评分。贝斯练习默认关闭伴奏低音。
          </p>
        </div>
      )}
      {!metronomeOnly && generated.error && (
        <p className="ws-error" role="alert">
          {generated.error}
        </p>
      )}
      {!metronomeOnly && voicings.length > 0 && (
        <div className="ws-voicings">
          {voicings.slice(0, 4).map((v, i) => (
            <ChordDiagram
              key={i}
              tuning={tuning}
              voicing={v}
              name={`${ROOTS[c.root]}${c.chord === 'major' ? '' : c.chord === 'minor' ? 'm' : c.chord === 'power' ? '5' : c.chord} · 指法 ${i + 1}`}
              onNote={preview}
            />
          ))}
        </div>
      )}
      {!metronomeOnly && generated.data && c.hint !== 'none' && (
        <Score
          events={generated.data.events}
          tuning={tuning}
          config={c}
          onSelect={(event) => {
            if (!allowAudioAction()) return
            pauseAudioSession()
            setSelected(event.notes)
            void audio
              ?.previewEvent(event, ((event.duration / beatUnit(c.meter)) * 60) / c.bpm)
              .catch((e) => onError(String(e)))
          }}
        />
      )}
      {!metronomeOnly && c.hint === 'none' && (
        <p className="ws-muted">谱面与指板提示已隐藏。在练习参数中切换“完整提示”可重新显示。</p>
      )}
      <p className="ws-shortcut-hint">
        <Volume2 size={13} />
        示范为本地合成参考音色 · 空格播放／暂停 · Home 重来 · 每次先练准确，再提高一个难度维度
      </p>
    </div>
  )
}
