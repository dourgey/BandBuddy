import { ArrowUpDown, ListMusic, LoaderCircle, Pause, Play, RotateCcw, RotateCw, SkipBack, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import {
  METRONOME_GAIN_LIMIT_DB,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  PITCH_SEMITONES_STEP,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  STEM_META,
  normalizeBeatOffsetMs
} from '@shared/domain.js'
import { usePlayerStore } from '../player-store.js'
import { Vinyl } from './Vinyl.js'
import { LoopButton } from './LoopButton.js'
import { activeLoopRange } from '@shared/playback.js'
import { clamp, formatTime } from '../utils.js'
import { LevelInput } from './LevelInput.js'

const PLAYBACK_RATES = [0.5, 0.8, 1, 1.2, 1.5] as const

function formatBpm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatPitch(value: number): string {
  return value === 0 ? '原调' : `${value > 0 ? '+' : '−'}${Math.abs(value)}`
}

export function PlayerBar({
  practiceMode,
  countInRemaining,
  locked,
  onToggle,
  onSeek,
  onRestart,
  onCycleLoop,
  onPractice
}: {
  practiceMode: boolean
  countInRemaining: number
  locked: boolean
  onToggle(): void
  onSeek(milliseconds: number): void
  onRestart(): void
  onCycleLoop(): void
  onPractice(): void
}): React.JSX.Element {
  const song = usePlayerStore((state) => state.song)
  const practice = usePlayerStore((state) => state.practice)
  const currentMs = usePlayerStore((state) => state.currentMs)
  const playing = usePlayerStore((state) => state.playing)
  const patchPractice = usePlayerStore((state) => state.patchPractice)
  const lastAudibleGain = useRef(0)
  const lastSongId = useRef<string | null>(null)

  useEffect(() => {
    if (!song || !practice) return
    if (lastSongId.current !== song.id) {
      lastSongId.current = song.id
      lastAudibleGain.current = practice.masterGainDb > -60 ? practice.masterGainDb : 0
    } else if (practice.masterGainDb > -60) lastAudibleGain.current = practice.masterGainDb
  }, [song, practice])

  if (!song || !practice) {
    return <footer className="player-bar is-empty">
      <div className="player-empty-mark"><ListMusic size={19} /></div>
      <div><b>选择一首歌曲开始练习</b><span>基础六轨完成即可练习，吉他三轨会在后台继续生成</span></div>
    </footer>
  }

  const muted = practice.masterGainDb <= -60
  const volume = muted ? 0 : Math.round(100 * 10 ** (practice.masterGainDb / 20))
  const volumeStyle = { '--volume': `${Math.min(100, volume / 1.5)}%` } as CSSProperties
  const playbackActive = playing || countInRemaining > 0
  return <footer className={`player-bar ${practiceMode ? 'practice-player-bar' : ''} ${locked ? 'is-locked' : ''}`} aria-disabled={locked}>
    <div className={`player-main-row ${practiceMode ? 'has-practice-controls' : ''}`}>
      <button className={`now-playing ${practiceMode ? 'practice-vinyl-dock' : ''}`} onClick={onPractice}>
        <Vinyl size={practiceMode ? 'medium' : 'small'} artworkUrl={song.artworkUrl} spinning={playbackActive} />
        {!practiceMode && <><span><small>{playing ? '正在练习' : '已暂停'} · {formatTime(currentMs)}</small><b>{song.title}</b><em>{song.artist || '未知艺术家'}</em></span><AudioMeter playing={playing} /></>}
        {practiceMode && countInRemaining > 0 && <span className="count-in-badge" aria-live="polite">{countInRemaining}</span>}
      </button>
      <div className="transport">
        <button className="restart-playback" disabled={locked} aria-label={activeLoopRange(practice) ? '跳回 A 点并播放' : '跳回开头并播放'} title={activeLoopRange(practice) ? '跳回 A 点并播放（Home）' : '跳回开头并播放（Home）'} onClick={onRestart}><SkipBack size={20} /></button>
        <button aria-label="后退 5 秒" onClick={() => onSeek(currentMs - 5000)}><RotateCcw size={22} /><i>5</i></button>
        <button className="main-play" aria-label={playbackActive ? '暂停' : '播放'} onClick={onToggle}>{playbackActive ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button>
        <button aria-label="前进 5 秒" onClick={() => onSeek(currentMs + 5000)}><RotateCw size={22} /><i>5</i></button>
      </div>
      {practiceMode && <PracticeFooterControls key={song.id} songId={song.id} songDurationMs={song.durationMs} currentMs={currentMs} locked={locked} onCycleLoop={onCycleLoop} onSeek={onSeek} />}
      <div className="footer-volume">
        <LevelInput
          label="主音量增益"
          value={practice.masterGainDb}
          onChange={(masterGainDb) => patchPractice({ masterGainDb })}
        />
        <button
          className={`volume-toggle ${muted ? 'is-muted' : ''}`}
          aria-label={muted ? '取消静音' : '静音'}
          aria-pressed={muted}
          onClick={() => patchPractice({ masterGainDb: muted ? lastAudibleGain.current : -60 })}
        >{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
        <input
          aria-label="总音量"
          type="range"
          min="0"
          max="150"
          value={Math.min(150, volume)}
          style={volumeStyle}
          onDoubleClick={() => patchPractice({ masterGainDb: 0 })}
          onChange={(event) => {
            const value = Number(event.target.value)
            patchPractice({ masterGainDb: value === 0 ? -60 : Math.min(6, 20 * Math.log10(value / 100)) })
          }}
        />
        <button className="queue-button" aria-label="打开练习室" onClick={onPractice}><ListMusic size={21} /></button>
      </div>
    </div>
  </footer>
}

function PracticeFooterControls({
  songId,
  songDurationMs,
  currentMs,
  locked,
  onCycleLoop,
  onSeek
}: {
  songId: string
  songDurationMs: number
  currentMs: number
  locked: boolean
  onCycleLoop(): void
  onSeek(milliseconds: number): void
}): React.JSX.Element {
  const song = usePlayerStore((state) => state.song)!
  const practice = usePlayerStore((state) => state.practice)!
  const patchPractice = usePlayerStore((state) => state.patchPractice)
  const [speedOpen, setSpeedOpen] = useState(false)
  const [pitchOpen, setPitchOpen] = useState(false)
  const [metronomeOpen, setMetronomeOpen] = useState(false)
  const [detectingBpm, setDetectingBpm] = useState(false)
  const [bpmMessage, setBpmMessage] = useState('')
  const speedPanel = useRef<HTMLDivElement>(null)
  const pitchPanel = useRef<HTMLDivElement>(null)
  const pitchToggle = useRef<HTMLButtonElement>(null)
  const pitchDialogId = useId()
  const metronomePanel = useRef<HTMLDivElement>(null)
  const alignmentSaveTimer = useRef<number | null>(null)
  const progress = songDurationMs > 0 ? Math.min(100, Math.max(0, currentMs / songDurationMs * 100)) : 0
  const loopStart = practice.loopStartMs === null || songDurationMs <= 0 ? null : practice.loopStartMs / songDurationMs * 100
  const loopEnd = practice.loopEndMs === null || songDurationMs <= 0 ? null : practice.loopEndMs / songDurationMs * 100
  const hasLyrics = Boolean(song.lyrics?.cues.length)
  const pitchDescription = practice.pitchSemitones === 0 ? '原调' : `${formatPitch(practice.pitchSemitones)} 半音`

  const shiftPitch = (direction: -1 | 1): void => {
    if (locked) return
    const currentPractice = usePlayerStore.getState().practice
    if (currentPractice) patchPractice({ pitchSemitones: currentPractice.pitchSemitones + direction * PITCH_SEMITONES_STEP })
  }

  useEffect(() => {
    if (!speedOpen && !pitchOpen && !metronomeOpen) return
    const close = (event: PointerEvent): void => {
      if (!speedPanel.current?.contains(event.target as Node)) setSpeedOpen(false)
      if (!pitchPanel.current?.contains(event.target as Node)) setPitchOpen(false)
      if (!metronomePanel.current?.contains(event.target as Node)) setMetronomeOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [metronomeOpen, pitchOpen, speedOpen])

  useEffect(() => () => {
    if (alignmentSaveTimer.current !== null) window.clearTimeout(alignmentSaveTimer.current)
  }, [])

  const saveBpm = (metronomeBpm: number): void => {
    const metronomeOffsetMs = Math.round(normalizeBeatOffsetMs(practice.metronomeOffsetMs, metronomeBpm))
    patchPractice({ metronomeBpm, metronomeOffsetMs })
    setBpmMessage('正在保存…')
    void window.bandbuddy.library.update({ id: songId, patch: { bpm: metronomeBpm, beatOffsetMs: metronomeOffsetMs } }).then(() => {
      setBpmMessage(`已保存 ${formatBpm(metronomeBpm)} BPM`)
    }).catch(() => setBpmMessage('BPM 保存失败，请重试'))
  }

  const saveBeatOffset = (offsetMs: number): void => {
    const metronomeOffsetMs = Math.round(normalizeBeatOffsetMs(offsetMs, practice.metronomeBpm))
    patchPractice({ metronomeOffsetMs })
    setBpmMessage('正在保存拍点对齐…')
    if (alignmentSaveTimer.current !== null) window.clearTimeout(alignmentSaveTimer.current)
    alignmentSaveTimer.current = window.setTimeout(() => {
      alignmentSaveTimer.current = null
      void window.bandbuddy.library.update({ id: songId, patch: { beatOffsetMs: metronomeOffsetMs } }).then(() => {
        setBpmMessage(`拍点已${metronomeOffsetMs < 0 ? '提前' : metronomeOffsetMs > 0 ? '延后' : '重置'} ${Math.abs(metronomeOffsetMs)} ms`)
      }).catch(() => setBpmMessage('拍点对齐保存失败，请重试'))
    }, 250)
  }

  const detectBpm = async (): Promise<void> => {
    setDetectingBpm(true)
    setBpmMessage('正在分析当前歌曲…')
    try {
      const result = await window.bandbuddy.media.detectBpm(songId)
      patchPractice({ metronomeBpm: result.bpm, metronomeOffsetMs: result.beatOffsetMs })
      setBpmMessage(`检测到 ${formatBpm(result.bpm)} BPM · ${STEM_META[result.analyzedStem].label}轨 · 拍点 ${result.beatOffsetMs >= 0 ? '+' : ''}${result.beatOffsetMs} ms · 已保存`)
    } catch (error) {
      const message = String(error)
      setBpmMessage(message.includes('FFMPEG_MISSING') ? 'BPM 检测组件不可用' : message.includes('UNSTABLE') ? '未检测到稳定节拍，可手动填写' : 'BPM 检测失败，请重试')
    } finally {
      setDetectingBpm(false)
    }
  }

  return <div className="practice-footer-controls">
    <div className="footer-timeline">
      <span className="footer-time current">{formatTime(currentMs)}</span>
      <div className="footer-progress-wrap">
        <span className="footer-progress-visual"><i style={{ width: `${progress}%` }} /></span>
        <input
          className="footer-progress-range"
          aria-label="歌曲进度"
          type="range"
          min="0"
          max={Math.max(0, songDurationMs)}
          step="100"
          value={Math.min(songDurationMs, Math.max(0, currentMs))}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        {loopStart !== null && <i className="footer-loop-marker marker-a" style={{ left: `${loopStart}%` }}>A</i>}
        {loopEnd !== null && <i className="footer-loop-marker marker-b" style={{ left: `${loopEnd}%` }}>B</i>}
      </div>
      <span className="footer-time">{formatTime(songDurationMs)}</span>
    </div>

    <div className="footer-option loop-option" aria-label="循环控制">
      <LoopButton practice={practice} disabled={locked || songDurationMs <= 0} onClick={onCycleLoop} />
    </div>

    <div className="footer-option speed-option" ref={speedPanel}>
      <span className="footer-segmented">
        {PLAYBACK_RATES.map((rate) => <button key={rate} className={practice.playbackRate === rate ? 'active' : ''} onClick={() => patchPractice({ playbackRate: rate })}>{rate.toFixed(1)}</button>)}
        <button className={`continuous-speed ${speedOpen ? 'active' : ''}`} aria-label="无级变速" aria-expanded={speedOpen} onClick={() => { setPitchOpen(false); setMetronomeOpen(false); setSpeedOpen(!speedOpen) }}><SlidersHorizontal size={12} /></button>
      </span>
      {speedOpen && <div className="speed-popover" role="dialog" aria-label="无级变速滑轨">
        <header><span>无级变速</span><b>{practice.playbackRate.toFixed(2)}×</b></header>
        <input aria-label="无级播放速度" type="range" min={PLAYBACK_RATE_MIN} max={PLAYBACK_RATE_MAX} step="0.01" value={practice.playbackRate} onChange={(event) => patchPractice({ playbackRate: Number(event.target.value) })} />
        <footer><span>0.2×</span><span>1×</span><span>2×</span><span>4×</span></footer>
      </div>}
    </div>

    <div
      className="footer-option pitch-option"
      ref={pitchPanel}
      role="group"
      aria-label="升降调（鼓轨除外）"
      onKeyDown={(event) => {
        // Keep pitch-control keys from also seeking, changing track gain or clearing the loop.
        event.stopPropagation()
        if (event.key === 'Escape' && pitchOpen) {
          setPitchOpen(false)
          pitchToggle.current?.focus()
        }
      }}
    >
      <span className={`pitch-controls ${practice.pitchSemitones !== 0 ? 'is-enabled' : ''}`}>
        <button className="pitch-step" aria-label="降低半音" title="降低半音 · 最低 −12" disabled={locked || practice.pitchSemitones <= PITCH_SEMITONES_MIN} onClick={() => shiftPitch(-1)}>♭</button>
        <button
          ref={pitchToggle}
          className={`pitch-button ${pitchOpen ? 'active' : ''}`}
          aria-label={`升降调：${pitchDescription}`}
          aria-expanded={pitchOpen}
          aria-controls={pitchOpen ? pitchDialogId : undefined}
          aria-haspopup="dialog"
          disabled={locked}
          title="升降调设置 · 鼓轨保持原音"
          onClick={() => { setSpeedOpen(false); setMetronomeOpen(false); setPitchOpen(!pitchOpen) }}
        ><small>升降调</small><span aria-live="polite">{formatPitch(practice.pitchSemitones)}</span></button>
        <button className="pitch-step" aria-label="升高半音" title="升高半音 · 最高 +12" disabled={locked || practice.pitchSemitones >= PITCH_SEMITONES_MAX} onClick={() => shiftPitch(1)}>♯</button>
      </span>
      <button className="pitch-reset" aria-label="恢复原调" title="恢复原调" disabled={locked || practice.pitchSemitones === 0} onClick={() => patchPractice({ pitchSemitones: 0 })}><RotateCcw size={13} /></button>
      {pitchOpen && <div className="pitch-popover" id={pitchDialogId} role="dialog" aria-label="升降调设置" aria-describedby={`${pitchDialogId}-hint`}>
        <header><span><ArrowUpDown size={14} />升降调</span><b>{formatPitch(practice.pitchSemitones)}{practice.pitchSemitones !== 0 && <small> 半音</small>}</b></header>
        <div className="pitch-slider-controls">
          <button className="pitch-slider-step" aria-label="降低 1 半音" title="降低 1 半音" disabled={locked || practice.pitchSemitones <= PITCH_SEMITONES_MIN} onClick={() => shiftPitch(-1)}>−</button>
          <input
            aria-label="升降调半音数"
            type="range"
            min={PITCH_SEMITONES_MIN}
            max={PITCH_SEMITONES_MAX}
            step={PITCH_SEMITONES_STEP}
            value={practice.pitchSemitones}
            aria-valuetext={pitchDescription}
            disabled={locked}
            onKeyDown={(event) => {
              if (locked) return
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                event.preventDefault()
                shiftPitch(-1)
              } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                event.preventDefault()
                shiftPitch(1)
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                patchPractice({ pitchSemitones: event.key === 'Home' ? PITCH_SEMITONES_MIN : PITCH_SEMITONES_MAX })
              }
            }}
            onChange={(event) => { if (!locked) patchPractice({ pitchSemitones: Number(event.target.value) }) }}
          />
          <button className="pitch-slider-step" aria-label="升高 1 半音" title="升高 1 半音" disabled={locked || practice.pitchSemitones >= PITCH_SEMITONES_MAX} onClick={() => shiftPitch(1)}>+</button>
        </div>
        <footer><span>−12 · 低八度</span><span>原调</span><span>+12 · 高八度</span></footer>
        <p id={`${pitchDialogId}-hint`}>每次 1 半音 · 鼓轨保持原音<br />人声、贝斯、吉他、钢琴及其他分轨统一变调</p>
      </div>}
    </div>

    <div className="footer-option metronome-option" ref={metronomePanel}>
      <button className={`metronome-icon-button ${practice.metronomeEnabled ? 'is-enabled' : ''} ${metronomeOpen ? 'active' : ''}`} aria-label="节拍器" aria-expanded={metronomeOpen} onClick={() => { setSpeedOpen(false); setPitchOpen(false); setMetronomeOpen(!metronomeOpen) }}><MetronomeIcon /></button>
      {metronomeOpen && <div className="metronome-popover" role="dialog" aria-label="节拍器设置">
        <header><span><MetronomeIcon /><b>节拍器</b></span><em>{formatBpm(practice.metronomeBpm)} BPM</em></header>
        <div className="metronome-switch-row">
          <span><b>播放时发声</b><small>预备拍结束后继续打拍</small></span>
          <button className={`metronome-switch ${practice.metronomeEnabled ? 'active' : ''}`} role="switch" aria-checked={practice.metronomeEnabled} onClick={() => patchPractice({ metronomeEnabled: !practice.metronomeEnabled })}><i /></button>
        </div>
        <div className="metronome-volume-row">
          <span><b>音量</b><small>独立音量 · 不受主音量及静音影响</small></span>
          <LevelInput label="节拍器音量" value={practice.metronomeGainDb} min={-METRONOME_GAIN_LIMIT_DB} max={METRONOME_GAIN_LIMIT_DB} onChange={(metronomeGainDb) => patchPractice({ metronomeGainDb })} />
        </div>
        <input
          className="metronome-volume-slider"
          aria-label="节拍器音量滑块"
          type="range"
          min={-METRONOME_GAIN_LIMIT_DB}
          max={METRONOME_GAIN_LIMIT_DB}
          step="0.5"
          value={practice.metronomeGainDb}
          // The fill starts at unity (the middle of the symmetric range) so 0 dB is the visible origin.
          style={{
            '--fill-from': `${Math.min(50, ((practice.metronomeGainDb + METRONOME_GAIN_LIMIT_DB) / (METRONOME_GAIN_LIMIT_DB * 2)) * 100)}%`,
            '--fill-to': `${Math.max(50, ((practice.metronomeGainDb + METRONOME_GAIN_LIMIT_DB) / (METRONOME_GAIN_LIMIT_DB * 2)) * 100)}%`
          } as CSSProperties}
          onDoubleClick={() => patchPractice({ metronomeGainDb: 0 })}
          onChange={(event) => patchPractice({ metronomeGainDb: Number(event.target.value) })}
        />
        <div className="metronome-bpm-row"><span>BPM</span><MetronomeBpmInput value={practice.metronomeBpm} onChange={saveBpm} /></div>
        <button className="detect-bpm-button" disabled={detectingBpm} onClick={() => void detectBpm()}>{detectingBpm ? <LoaderCircle className="spin" size={15} /> : <MetronomeIcon />}<span><b>{detectingBpm ? '正在检测…' : '检测当前歌曲 BPM'}</b><small>优先分析鼓轨，结果自动保存</small></span></button>
        {bpmMessage && <p className={bpmMessage.includes('失败') || bpmMessage.includes('未检测') || bpmMessage.includes('不可用') ? 'error' : ''}>{bpmMessage}</p>}
        <div className="beat-alignment-row">
          <span><b>拍点微调</b><small>负值提前 · 正值延后</small></span>
          <em>{practice.metronomeOffsetMs >= 0 ? '+' : ''}{Math.round(practice.metronomeOffsetMs)} ms</em>
        </div>
        <div className="beat-alignment-controls">
          <button aria-label="拍点提前 10 毫秒" onClick={() => saveBeatOffset(practice.metronomeOffsetMs - 10)}>−10</button>
          <input
            aria-label="节拍时间微调"
            className="beat-alignment-slider"
            type="range"
            min={-Math.round(30_000 / practice.metronomeBpm)}
            max={Math.round(30_000 / practice.metronomeBpm)}
            step="1"
            value={Math.round(normalizeBeatOffsetMs(practice.metronomeOffsetMs, practice.metronomeBpm))}
            // Aligned (0 ms) is the origin, so the fill grows out of the middle like the level slider.
            style={{
              '--fill-from': `${Math.min(50, 50 + (Math.round(normalizeBeatOffsetMs(practice.metronomeOffsetMs, practice.metronomeBpm)) / Math.round(30_000 / practice.metronomeBpm)) * 50)}%`,
              '--fill-to': `${Math.max(50, 50 + (Math.round(normalizeBeatOffsetMs(practice.metronomeOffsetMs, practice.metronomeBpm)) / Math.round(30_000 / practice.metronomeBpm)) * 50)}%`
            } as CSSProperties}
            onChange={(event) => saveBeatOffset(Number(event.target.value))}
          />
          <button aria-label="拍点延后 10 毫秒" onClick={() => saveBeatOffset(practice.metronomeOffsetMs + 10)}>+10</button>
        </div>
        <button className="reset-beat-alignment" disabled={practice.metronomeOffsetMs === 0} onClick={() => saveBeatOffset(0)}>重置拍点偏移</button>
        <div className="count-in-row"><span><b>预备拍</b><small>播放前先响几拍</small></span><span className="footer-segmented count-in-options">
          {([0, 4, 8] as const).map((beats) => <button key={beats} className={practice.countInBeats === beats ? 'active' : ''} onClick={() => patchPractice({ countInBeats: beats })}>{beats === 0 ? '关闭' : `${beats} 拍`}</button>)}
        </span></div>
      </div>}
    </div>

    <div className="footer-option desktop-lyrics-option">
      <button
        className={`metronome-icon-button desktop-lyrics-button ${practice.desktopLyricsEnabled ? 'is-enabled' : ''}`}
        aria-label={practice.desktopLyricsEnabled ? '关闭桌面歌词' : '打开桌面歌词'}
        aria-pressed={practice.desktopLyricsEnabled}
        disabled={!hasLyrics}
        title={hasLyrics ? (practice.desktopLyricsEnabled ? '关闭桌面歌词' : '打开桌面歌词') : '请先在“更多”中导入 LRC 歌词'}
        onClick={() => patchPractice({ desktopLyricsEnabled: !practice.desktopLyricsEnabled })}
      >词</button>
    </div>
  </div>
}

function MetronomeBpmInput({ value, onChange }: { value: number; onChange(value: number): void }): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return }
    const next = Math.round(clamp(parsed, 20, 400) * 10) / 10
    setDraft(formatBpm(next))
    if (next !== value) onChange(next)
  }

  return <label className="metronome-bpm"><input
    aria-label="节拍器 BPM"
    type="number"
    min="20"
    max="400"
    step="0.1"
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
  /><span>BPM</span></label>
}

function MetronomeIcon(): React.JSX.Element {
  return <svg className="metronome-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 3h8l3.3 18H4.7L8 3Z" />
    <path d="m12 7 3.2 8.3M8.5 17.3h7" />
    <circle cx="12" cy="7" r="1" />
  </svg>
}

function AudioMeter({ playing }: { playing: boolean }): React.JSX.Element {
  return <span className={`audio-meter ${playing ? 'playing' : ''}`} aria-hidden>
    {[8, 16, 22, 13].map((height, index) => <i key={index} style={{ height }} />)}
  </span>
}
