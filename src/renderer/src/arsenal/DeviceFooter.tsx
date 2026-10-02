import { allowAudioAction, isRecordingLocked, useRecordingSession } from '../recording-session.js'
import { useEffect, useRef, useState } from 'react'
import { Headphones, RefreshCw } from 'lucide-react'
import type { AppSettings, RecordingAudioSettings, RecordingDeviceInfo } from '@shared/domain.js'
import type { ArsenalMonitorState, EffectChainSnapshot, MonitorMode } from '@shared/arsenal.js'
import { Select } from '../components/ui/Select.js'
import { reconfigureArsenalAudio } from './audio-routing.js'

interface Props {
  monitor: MonitorMode
  busy: boolean
  getChain(): EffectChainSnapshot
  onMonitor(mode: MonitorMode): void
  onRouting(busy: boolean): void
  onToast(message: string): void
}
const idle: ArsenalMonitorState = { active: false, mode: 'off', sampleRate: 0, bufferFrames: 0, latencyMs: 0, peak: [], outputPeak: 0, xruns: 0, error: null }

export function DeviceFooter({ monitor, busy, getChain, onMonitor, onRouting, onToast }: Props): React.JSX.Element {
  const recording = useRecordingSession()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [devices, setDevices] = useState<RecordingDeviceInfo[]>([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const editing = useRef(false)
  const callbacks = useRef({ getChain, onRouting, onToast })
  callbacks.current = { getChain, onRouting, onToast }
  const scan = async (): Promise<void> => {
    if (isRecordingLocked()) return
    setScanning(true)
    try { const found = await window.bandbuddy.recording.devices(); if (mounted.current) { setDevices(found); setError('') } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '无法读取音频设备，可以重试扫描。') }
    finally { if (mounted.current) setScanning(false) }
  }
  useEffect(() => {
    mounted.current = true
    let changed = false
    const unsubscribe = window.bandbuddy.settings.onChanged(value => { changed = true; if (mounted.current) setSettings(value) })
    void window.bandbuddy.settings.get().then(value => { if (mounted.current && !changed) setSettings(value) }).catch(reason => { if (mounted.current) setError(String(reason)) })
    return () => { mounted.current = false; unsubscribe() }
  }, [])
  useEffect(() => { if (!recording) void scan() }, [Boolean(recording)])
  const configure = async (edit: (current: RecordingAudioSettings) => RecordingAudioSettings): Promise<void> => {
    if (!allowAudioAction() || busy || editing.current) return
    editing.current = true
    callbacks.current.onRouting(true)
    setError('')
    try {
      const saved = await reconfigureArsenalAudio(window.bandbuddy, edit, () => callbacks.current.getChain(), () => mounted.current && !isRecordingLocked())
      if (mounted.current) setSettings(saved)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '音频配置未生效，请检查设备后重试。'
      if (mounted.current) { setError(message); callbacks.current.onToast(message) }
      // Show the actual persisted configuration even if only restarting the stream failed.
      try { const saved = await window.bandbuddy.settings.get(); if (mounted.current) setSettings(saved) } catch { /* Keep the last known configuration. */ }
    } finally {
      editing.current = false
      if (mounted.current) callbacks.current.onRouting(false)
    }
  }
  const audio = settings?.recordingAudio
  const backend = audio?.backend === 'auto' ? (/Mac/i.test(navigator.platform) ? 'coreaudio' : 'wasapi-shared') : audio?.backend
  const input = devices.find(device => device.id === audio?.inputDeviceId) ?? devices.find(device => device.backend === backend && device.defaultInput)
  const deviceValue = audio && audio.inputDeviceId === audio.outputDeviceId ? audio.inputDeviceId : '__separate__'
  const duplex = devices.filter(device => device.inputChannels > 0 && device.outputChannels > 0)
  const channelCount = input?.inputChannels ?? 2
  const channels = Array.from({ length: channelCount }, (_, index) => [index]).concat(Array.from({ length: Math.floor(channelCount / 2) }, (_, index) => [index * 2, index * 2 + 1]))
  const channelValue = audio?.inputChannels.join(',') ?? '0'
  const sampleRates = [...new Set([0, ...(input?.sampleRates ?? [44100, 48000, 96000]), audio?.sampleRate ?? 0])].sort((a, b) => a - b)
  const buffers = [...new Set([0, 64, 128, 256, 512, 1024, 2048, audio?.bufferFrames ?? 0])].sort((a, b) => a - b)
  const disabled = busy || !audio || Boolean(recording)
  return <footer className="arsenal-footer">
    <div className="footer-device">
      <Headphones size={16} aria-hidden="true" />
      <label>音频设备<Select aria-label="实时音频设备" value={deviceValue} disabled={disabled || scanning} onChange={event => {
        const device = duplex.find(item => item.id === event.target.value)
        void configure(current => {
          const backend = device?.backend ?? current.backend
          const deviceId = device?.id ?? ''
          const resolved = backend === 'auto' ? (/Mac/i.test(navigator.platform) ? 'coreaudio' : 'wasapi-shared') : backend
          const keepChannels = device && current.inputChannels.every(channel => channel < device.inputChannels)
          return { ...current, backend, inputDeviceId: deviceId, outputDeviceId: deviceId,
            inputChannelMode: keepChannels ? current.inputChannelMode : 'mono', inputChannels: keepChannels ? current.inputChannels : [0],
            sampleRate: !device?.sampleRates.length || device.sampleRates.includes(current.sampleRate) ? current.sampleRate : 0,
            alignmentOffsetMs: current.deviceAlignmentOffsets[`${resolved}|${deviceId || 'default'}|${deviceId || 'default'}`] ?? 0 }
        })
      }}><option value="">系统默认</option>{deviceValue === '__separate__' && <option value="__separate__" disabled>当前输入 / 输出分别配置</option>}{deviceValue && deviceValue !== '__separate__' && !duplex.some(device => device.id === deviceValue) && <option value={deviceValue} disabled>设备未连接</option>}{duplex.map(device => <option key={device.id} value={device.id}>{device.name} · {device.backend}</option>)}</Select></label>
      <button className="icon-button" aria-label="重新扫描音频设备" title="重新扫描音频设备" disabled={disabled || scanning} onClick={() => void scan()}><RefreshCw size={14} /></button>
      <label>输入通道<Select aria-label="实时输入通道" value={channelValue} disabled={disabled} onChange={event => { const next = event.target.value.split(',').map(Number); void configure(current => ({ ...current, inputChannelMode: next.length === 2 ? 'stereo' : 'mono', inputChannels: next })) }}>{!channels.some(value => value.join(',') === channelValue) && <option value={channelValue} disabled>当前通道不可用</option>}{channels.map(value => <option value={value.join(',')} key={value.join(',')}>{value.map(index => index + 1).join(' + ')}{value.length === 2 ? '（立体声）' : ''}</option>)}</Select></label>
      <label>采样率<Select aria-label="实时采样率" value={audio?.sampleRate ?? 0} disabled={disabled} onChange={event => { const sampleRate = Number(event.target.value); void configure(current => ({ ...current, sampleRate })) }}>{sampleRates.map(rate => <option key={rate} value={rate}>{rate ? `${rate / 1000} kHz` : '自动'}</option>)}</Select></label>
      <label>缓冲区<Select aria-label="实时缓冲区" value={audio?.bufferFrames ?? 0} disabled={disabled} onChange={event => { const bufferFrames = Number(event.target.value); void configure(current => ({ ...current, bufferFrames })) }}>{buffers.map(frames => <option key={frames} value={frames}>{frames ? `${frames} frames` : '自动'}</option>)}</Select></label>
    </div>
    <div className="footer-monitor"><span>监听</span>{(['off', 'dry', 'wet'] as MonitorMode[]).map(mode => <button key={mode} disabled={busy || Boolean(recording)} aria-pressed={monitor === mode} className={monitor === mode ? 'active' : ''} onClick={() => onMonitor(mode)}>{mode === 'off' ? '关闭' : mode === 'dry' ? '干声' : '效果'}</button>)}<MonitorReadout /></div>
    {error && <p className="arsenal-device-error" role="alert">{error}</p>}
  </footer>
}

/** Native peak packets only rerender this readout, never the rack, preset list, or controls. */
function MonitorReadout(): React.JSX.Element {
  const [state, setState] = useState(idle)
  useEffect(() => {
    let mounted = true
    let changed = false
    const unsubscribe = window.bandbuddy.arsenal.onMonitor(value => { changed = true; if (mounted) setState(value) })
    void window.bandbuddy.arsenal.monitorState().then(value => { if (mounted && !changed) setState(value) }).catch(() => undefined)
    return () => { mounted = false; unsubscribe() }
  }, [])
  const peak = Math.max(0, Math.min(1, state.active ? state.outputPeak : 0))
  return <span className="arsenal-monitor-readout">
    <span className="arsenal-level-meter" role="meter" aria-label="实时输出电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(peak * 100)}><span style={{ width: `${peak * 100}%` }} /></span>
    <small>{state.active ? `${state.mode === 'wet' ? '效果' : '干声'}监听 · ${state.sampleRate / 1000} kHz · ${state.bufferFrames} frames · ${state.latencyMs.toFixed(1)} ms` : '未监听'}{state.xruns > 0 ? ` · ${state.xruns} 次中断` : ''}</small>
    {state.error && <small role="alert">{state.error}</small>}
  </span>
}
