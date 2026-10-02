import { useEffect, useRef, useState } from 'react'
import { Guitar, Mic, MicOff, Settings } from 'lucide-react'
import { detectPitch, pitchReading } from './pitch.js'
import { detectPolyStrings, type StringPitch } from './poly-pitch.js'
import { selectInputChannel } from './input-channel.js'
import { noteName, type Tuning } from './theory.js'
import { AnalogTunerGauge } from './AnalogTunerGauge.js'
import { PolyTunerGauge } from './PolyTunerGauge.js'
import { SelectMenu } from '../components/SelectMenu.js'
export function Tuner({
  presetControl,
  instrumentSettings,
  tuning,
  capo,
  a4,
  onA4,
  inputDevice,
  onDevice,
  inputChannel,
  onChannel,
  onError
}: {
  presetControl: React.ReactNode
  instrumentSettings: React.ReactNode
  tuning: Tuning
  capo: number
  a4: number
  onA4: (n: number) => void
  inputDevice: string
  onDevice: (id: string) => void
  inputChannel: number
  onChannel: (channel: number) => void
  onError: (s: string) => void
}): React.JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('正在连接麦克风…'),
    [target, setTarget] = useState<number | null>(null)
  const [reading, setReading] = useState<{ midi: number; cents: number; hz: number } | null>(null),
    [level, setLevel] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<'mono' | 'poly'>('mono')
  const [polyReadings, setPolyReadings] = useState<Array<StringPitch | null>>([])
  const [modeToast, setModeToast] = useState('')
  const [channelCount, setChannelCount] = useState(0)
  const [selectedChannel, setSelectedChannel] = useState(0)
  const stream = useRef<MediaStream | null>(null),
    context = useRef<AudioContext | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    token = useRef(0)
  const current = useRef({ a4, target, tuning, capo, inputChannel })
  const devicePreference = useRef({ inputDevice, onDevice })
  devicePreference.current = { inputDevice, onDevice }
  current.current = { a4, target, tuning, capo, inputChannel }
  const stop = (resetView = true): void => {
    token.current++
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void context.current?.close()
    context.current = null
    if (resetView) {
      setActive(false)
      setBusy(false)
      setReading(null)
      setMode('mono')
      setPolyReadings([])
      setLevel(0)
      setChannelCount(0)
      setSelectedChannel(0)
    }
  }
  useEffect(() => {
    setTarget(null)
    setReading(null)
  }, [tuning.id, tuning.notes, capo])
  useEffect(() => {
    const refresh = () => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((items) => {
          const inputs = items.filter((d) => d.kind === 'audioinput')
          setDevices(inputs)
          const preference = devicePreference.current
          if (stream.current && preference.inputDevice && !inputs.some(d => d.deviceId === preference.inputDevice)) preference.onDevice('')
        })
        .catch(() => {})
    }
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [])
  const start = async (): Promise<void> => {
    stop()
    setBusy(true)
    const ticket = token.current
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('当前环境无法访问麦克风，请在桌面应用或 localhost 中打开。')
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDevice ? { exact: inputDevice } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 8 }
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
      const source = ctx.createMediaStreamSource(media)
      const count = Math.max(1, Math.min(16, media.getAudioTracks()[0]?.getSettings().channelCount || 2))
      const splitter = ctx.createChannelSplitter(count)
      const analysers = Array.from({ length: count }, (_, index) => {
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 8192
        splitter.connect(analyser, index, 0)
        return analyser
      })
      source.connect(splitter)
      const channelSamples = analysers.map((analyser) => new Float32Array(analyser.fftSize))
      let activeChannel = 0
      setChannelCount(count)
      let lastMidi = -999,
        stable = 0
      let viewMode: 'mono' | 'poly' = 'mono'
      let polyFrames = 0, monoFrames = 0, polyEntered = 0, lastPolyReading = 0
      const stringLastSeen = Array<number>(6).fill(0)
      const snapshot: Array<StringPitch | null> = Array<StringPitch | null>(6).fill(null)
      setActive(true)
      setBusy(false)
      setStatus('')
      media.getAudioTracks()[0]!.onended = () => {
        if (ticket === token.current) {
          stop()
          setStatus('输入设备已断开，请重新选择设备。')
          onDevice('')
        }
      }
      const available = await navigator.mediaDevices.enumerateDevices()
      if (ticket !== token.current) return
      setDevices(available.filter((d) => d.kind === 'audioinput'))
      if (!inputDevice) {
        const settings = media.getAudioTracks()[0]?.getSettings()
        const actual = settings?.deviceId
        const physical = available.find(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
          && (d.deviceId === actual || Boolean(settings?.groupId && d.groupId === settings.groupId)))
        const remembered = physical?.deviceId ?? (actual && actual !== 'default' && actual !== 'communications' ? actual : '')
        if (remembered) onDevice(remembered)
      }
      timer.current = setInterval(() => {
        const levels = analysers.map((analyser, index) => {
          const data = channelSamples[index]!
          analyser.getFloatTimeDomainData(data)
          let power = 0
          for (let sample = 0; sample < data.length; sample++) power += data[sample]! ** 2
          return Math.sqrt(power / data.length)
        })
        activeChannel = selectInputChannel(levels, activeChannel, current.current.inputChannel)
        setSelectedChannel(activeChannel)
        const samples = channelSamples[activeChannel]!
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
          if (viewMode === 'poly' && performance.now() - lastPolyReading > 2000) {
            viewMode = 'mono'
            setMode('mono')
            setPolyReadings([])
          }
          return
        }
        const now = current.current
        if (now.target === null && now.tuning.instrument === 'guitar' && now.tuning.notes.length === 6) {
          const strings = detectPolyStrings(samples, ctx.sampleRate, now.tuning.notes.map((midi) => midi + now.capo), now.a4)
          const count = strings.filter(Boolean).length
          polyFrames = count >= 2 ? polyFrames + 1 : 0
          if (viewMode === 'mono' && polyFrames >= 2) {
            viewMode = 'poly'
            polyEntered = performance.now()
            setMode('poly')
            setModeToast('检测到多弦输入 · 已切换至快速调弦')
            setTimeout(() => setModeToast(''), 1900)
          }
          if (viewMode === 'poly') {
            if (count >= 2) {
              setStatus('')
              const instant = performance.now()
              strings.forEach((result, index) => {
                if (result) { snapshot[index] = result; stringLastSeen[index] = instant }
                else if (instant - stringLastSeen[index]! > 1500) snapshot[index] = null
              })
              setPolyReadings([...snapshot])
              lastPolyReading = instant
              monoFrames = 0
            } else if (count === 1 && performance.now() - polyEntered >= 700) {
              monoFrames++
              if (monoFrames >= 6) {
                viewMode = 'mono'
                setMode('mono')
                setPolyReadings([])
                setModeToast('已切换至精确调弦')
                setTimeout(() => setModeToast(''), 1900)
              }
            } else monoFrames = 0
            if (viewMode === 'poly') return
          }
        }
        if (!pitch.frequency) {
          setStatus('未检测到稳定音高')
          setReading(null)
          stable = 0
          return
        }
        const detected = pitchReading(pitch.frequency, now.a4)
        stable = detected.midi === lastMidi ? stable + 1 : 0
        lastMidi = detected.midi
        if (stable < 2) {
          setStatus('')
          return
        }
        const targetMidi =
          now.target === null ? undefined : now.tuning.notes[now.tuning.notes.length - now.target]! + now.capo
        const result = pitchReading(pitch.frequency, now.a4, targetMidi)
        setReading({ ...result, hz: pitch.frequency })
        setStatus('')
      }, 90)
    } catch (error) {
      if (ticket !== token.current) return
      stop()
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
      if (inputDevice && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
        onDevice('')
        return
      }
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
  useEffect(() => {
    void start()
    return () => stop(false)
  }, [inputDevice])
  const detectedIndex = reading ? tuning.notes.findIndex((note) => note + capo === reading.midi) : -1
  const currentString = target ?? (detectedIndex < 0 ? null : tuning.notes.length - detectedIndex)
  return (
    <section className={`ws-tuner is-${mode}`} aria-label="调音器">
      <div className="ws-tuner-fasteners" aria-hidden="true"><i /><i /><i /><i /></div>
      <header className="ws-tuner-header">
        <div><small>LISTEN &amp; TUNE</small><h2>调音器</h2></div>
        <div className="ws-tuner-preset"><span className="ws-tuner-preset-icon" aria-hidden="true"><Guitar size={25} strokeWidth={2.1} /></span>{presetControl}</div>
        <button className="ws-tuner-settings-button" aria-label="调音器设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Settings size={23} /></button>
      </header>
      {settingsOpen && <div className="ws-tuner-settings">
        {instrumentSettings}
        <label>输入通道<select value={inputChannel <= channelCount ? inputChannel : 0} onChange={(e) => onChannel(Number(e.target.value))}>
          <option value={0}>自动选择有电平的通道</option>
          {Array.from({ length: channelCount }, (_, index) => <option key={index} value={index + 1}>通道 {index + 1}</option>)}
        </select></label>
        <label>A4 标准音<input type="number" min={430} max={450} value={a4} onChange={(e) => onA4(Math.max(430, Math.min(450, Math.round(Number(e.target.value)) || 440)))} /></label>
        <p>仅分析输入，不将麦克风声音送到扬声器。变调夹目标已计入当前音名。</p>
      </div>}
      {modeToast && <div className="ws-tuner-mode-toast" role="status">{modeToast}</div>}
      <div className="ws-tuner-gauge-stage">
        {mode === 'mono' ? <AnalogTunerGauge reading={reading} /> : <PolyTunerGauge notes={tuning.notes} capo={capo} readings={polyReadings} />}
      </div>
      {mode === 'mono' && <div className="ws-tuner-strings" aria-label="目标琴弦">
        {tuning.notes.map((midi, index) => {
          const string = tuning.notes.length - index
          return <div key={index} className={currentString === string ? 'selected' : ''}>
            <button aria-label={`${string} 弦 ${noteName(midi + capo)}${target === string ? '，已锁定' : ''}`} aria-pressed={target === string} onClick={() => setTarget(target === string ? null : string)}>{noteName(midi + capo)}</button>
            <i />
          </div>
        })}
      </div>}
      <div className="ws-tuner-input">
        <div className="ws-tuner-device-choice">{active ? <Mic size={17} /> : <MicOff size={17} />}
          <SelectMenu ariaLabel="音频输入" value={inputDevice} onChange={onDevice}
            options={[{ value: '', label: '系统默认输入' }, ...devices.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ value: d.deviceId, label: d.label || `输入设备 ${i + 1}` }))]} />
          <small>{busy ? '正在连接…' : active ? `通道 ${selectedChannel + 1}` : '输入不可用'}</small>
        </div>
        <div className="ws-input-level" role="meter" aria-label="输入电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ width: `${level * 100}%` }} /></div>
        <span className="ws-tuner-waveform" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span>
      </div>
      <p className="ws-tuner-status" role="status">{status || (active ? mode === 'poly' ? '检测到扫弦，已自动切换到多音模式' : '正在监听… 请拨动琴弦' : '请选择可用的音频输入')}</p>
    </section>
  )
}
