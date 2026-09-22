import { allowAudioAction, useRecordingSession } from '../recording-session.js'
import { pauseAudioSession } from '../audio-session.js'
import { Select } from '../components/ui/Select.js'
import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Volume2 } from 'lucide-react'
import { detectPitch, pitchReading } from './pitch.js'
import { noteName, type Tuning } from './theory.js'
import type { WoodshedAudio } from './audio.js'
export function Tuner({
  visible = true,
  tuning,
  capo,
  a4,
  onA4,
  inputDevice,
  onDevice,
  audio,
  onError
}: {
  visible?: boolean
  tuning: Pick<Tuning, 'id' | 'notes'>
  capo: number
  a4: number
  onA4: (n: number) => void
  inputDevice: string
  onDevice: (id: string) => void
  audio: WoodshedAudio | null
  onError: (s: string) => void
}): React.JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('点击开启调音，允许访问音频输入。'),
    [target, setTarget] = useState<number | null>(null)
  const [reading, setReading] = useState<{ midi: number; cents: number; hz: number } | null>(null),
    [level, setLevel] = useState(0)
  const stream = useRef<MediaStream | null>(null),
    context = useRef<AudioContext | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    token = useRef(0)
  const recording = useRecordingSession()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const current = useRef({ a4, target, tuning, capo })
  current.current = { a4, target, tuning, capo }
  const stop = (): void => {
    token.current++
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void context.current?.close()
    context.current = null
    setActive(false)
    setBusy(false)
    setReading(null)
    setLevel(0)
  }
  useEffect(() => { if (recording) stop() }, [Boolean(recording)])
  useEffect(
    () => () => {
      token.current++
      if (timer.current) clearInterval(timer.current)
      stream.current?.getTracks().forEach((t) => t.stop())
      void context.current?.close()
    },
    []
  )
  useEffect(() => {
    setTarget(null)
    setReading(null)
  }, [tuning.id, tuning.notes, capo])
  useEffect(() => {
    const refresh = () => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((items) => setDevices(items.filter((d) => d.kind === 'audioinput')))
        .catch(() => {})
    }
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [])
  const start = async (): Promise<void> => {
    if (!allowAudioAction()) return
    stop()
    setBusy(true)
    const ticket = token.current
    audio?.stop()
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('当前环境无法访问麦克风，请在桌面应用或 localhost 中打开。')
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDevice ? { exact: inputDevice } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      })
      if (ticket !== token.current) {
        media.getTracks().forEach((t) => t.stop())
        return
      }
      stream.current = media
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      context.current = ctx
      await ctx.resume()
      if (ticket !== token.current) return
      const source = ctx.createMediaStreamSource(media),
        analyser = ctx.createAnalyser()
      analyser.fftSize = 8192
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let lastMidi = -999,
        stable = 0
      setActive(true)
      setBusy(false)
      setStatus('等待单个持续音…')
      media.getAudioTracks()[0]!.onended = () => {
        if (ticket === token.current) {
          stop()
          setStatus('输入设备已断开，请重新选择设备。')
        }
      }
      const available = await navigator.mediaDevices.enumerateDevices()
      if (ticket !== token.current) return
      setDevices(available.filter((d) => d.kind === 'audioinput'))
      timer.current = setInterval(() => {
        if (!visibleRef.current) return
        analyser.getFloatTimeDomainData(samples)
        const pitch = detectPitch(samples, ctx.sampleRate)
        setLevel(Math.min(1, pitch.rms * 5))
        if (pitch.peak >= 0.995) {
          setStatus('输入过载，请降低声卡增益。')
          setReading(null)
          return
        }
        if (pitch.rms < 0.003) {
          setStatus(pitch.rms < 0.0001 ? '没有输入，请检查设备与通道。' : '信号过弱，请靠近麦克风或提高输入增益。')
          setReading(null)
          stable = 0
          return
        }
        if (!pitch.frequency) {
          setStatus('音高不稳定，请只弹一根弦并保持。')
          setReading(null)
          stable = 0
          return
        }
        const now = current.current
        const detected = pitchReading(pitch.frequency, now.a4)
        stable = detected.midi === lastMidi ? stable + 1 : 0
        lastMidi = detected.midi
        if (stable < 2) {
          setStatus('正在稳定音高…')
          return
        }
        const targetMidi =
          now.target === null ? undefined : now.tuning.notes[now.tuning.notes.length - now.target]! + now.capo
        const result = pitchReading(pitch.frequency, now.a4, targetMidi)
        setReading({ ...result, hz: pitch.frequency })
        setStatus(
          Math.abs(result.cents) <= 5 ? '音准稳定' : result.cents < 0 ? '偏低 · 轻微升高音高' : '偏高 · 轻微降低音高'
        )
      }, 90)
    } catch (error) {
      if (ticket !== token.current) return
      stop()
      const name = error instanceof Error ? error.name : ''
      const message =
        name === 'NotAllowedError'
          ? '麦克风权限未获允许。可在系统设置中开启；参考音和其他工具仍可使用。'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? '没有找到所选输入设备，请重新选择。'
            : error instanceof Error
              ? error.message
              : '无法开启输入，请检查设备。'
      setStatus(message)
      onError(message)
    }
  }
  return (
    <section className="ws-tool-panel ws-tuner">
      <div className="ws-panel-heading">
        <div>
          <small>LISTEN & TUNE</small>
          <h2>调音器</h2>
        </div>
        <button className="ws-button primary" disabled={busy} onClick={() => (active ? stop() : void start())}>
          {active ? <MicOff size={16} /> : <Mic size={16} />} {busy ? '正在连接…' : active ? '关闭输入' : '开启调音'}
        </button>
      </div>
      <div className="ws-form-row">
        <label>
          音频输入
          <Select value={inputDevice} disabled={active || busy} onChange={(e) => onDevice(e.target.value)}>
            <option value="">系统默认输入</option>
            {devices
              .filter((d) => d.deviceId !== 'default')
              .map((d, i) => (
                <option value={d.deviceId} key={d.deviceId}>
                  {d.label || `输入设备 ${i + 1}`}
                </option>
              ))}
          </Select>
        </label>
        <label>
          A4 标准音
          <input
            type="number"
            min={430}
            max={450}
            value={a4}
            onChange={(e) => onA4(Math.max(430, Math.min(450, Math.round(Number(e.target.value)) || 440)))}
          />
        </label>
      </div>
      <div className="ws-tuner-note">
        {reading ? noteName(reading.midi) : '—'}
        <small>
          {reading
            ? `${reading.hz.toFixed(1)} Hz · ${reading.cents > 0 ? '+' : ''}${reading.cents.toFixed(1)} cents`
            : '单音识别 · 实际音高'}
        </small>
      </div>
      <div className="ws-tuner-meter">
        <span>−50</span>
        <div>
          <i
            className={reading && Math.abs(reading.cents) <= 5 ? 'in-tune' : ''}
            style={{ left: `${50 + Math.max(-50, Math.min(50, reading?.cents ?? 0))}%` }}
          />
          <b />
        </div>
        <span>+50</span>
      </div>
      <p role="status">{status}</p>
      <div className="ws-input-level">
        <i style={{ width: `${level * 100}%` }} />
      </div>
      <div className="ws-string-targets">
        <button aria-pressed={target === null} onClick={() => setTarget(null)}>
          自动
        </button>
        {[...tuning.notes].reverse().map((midi, i) => (
          <div key={i}>
            <button aria-pressed={target === i + 1} onClick={() => setTarget(i + 1)}>
              {i + 1} 弦 · {noteName(midi + capo)}
            </button>
            <button
              aria-label={`试听第 ${i + 1} 弦`}
              onClick={() => {
                stop()
                setStatus('参考音播放后，可重新开启调音。')
                if (!allowAudioAction()) return
                pauseAudioSession()
                void audio?.preview(midi + capo).catch((e) => onError(String(e)))
              }}
            >
              <Volume2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <p className="ws-muted">
        {tuning.id === 'violin'
          ? '标准调弦 G3–D4–A4–E5；显示所选 A4 下的十二平均律参考。'
          : '调音前移除变调夹可校准空弦；当前目标已计入变调夹。'}
        调音期间不监听输入，避免啸叫。请在系统中选择合适的声卡输入通道。
      </p>
    </section>
  )
}
