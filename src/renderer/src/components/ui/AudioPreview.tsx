import { allowAudioAction, useRecordingSession } from '../../recording-session.js'
import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'

const time = (value: number): string => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
export function AudioPreview({ src, label = '录音试听' }: { src: string; label?: string }): React.JSX.Element {
  const recording = useRecordingSession()
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => { if (recording) audio.current?.pause() }, [Boolean(recording)])
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  return <div className="bb-audio-preview" aria-label={label}>
    <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={() => setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0)} onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError('无法读取录音，请检查文件是否仍在原位置')} />
    <button type="button" className="bb-icon-button" aria-label={playing ? '暂停试听' : '播放录音'} onClick={() => { if (!audio.current || !allowAudioAction()) return; if (playing) audio.current.pause(); else void audio.current.play().catch(() => setError('暂时无法播放，请重试')) }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
    <input aria-label="试听进度" type="range" min={0} max={duration || 1} step={0.1} value={position} disabled={!duration} onChange={event => { if (!allowAudioAction()) return; const next = Number(event.target.value); if (audio.current) audio.current.currentTime = next; setPosition(next) }} />
    <span>{time(position)} / {time(duration)}</span>
    <button type="button" className="bb-icon-button" aria-label={muted ? '取消试听静音' : '试听静音'} aria-pressed={muted} onClick={() => { if (audio.current) audio.current.muted = !muted; setMuted(!muted) }}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
    <input className="bb-audio-volume" aria-label="试听音量" type="range" min={0} max={1} step={0.01} value={volume} onChange={event => { const next = Number(event.target.value); if (audio.current) audio.current.volume = next; setVolume(next) }} />{error && <span role="alert">{error}</span>}
  </div>
}
