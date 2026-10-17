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
      const saved = await reconfigureArsenalAudio(window.bandbuddy, current => {
        const next = edit(current)
        if (next.backend !== current.backend || next.inputDeviceId !== current.inputDeviceId || next.outputDeviceId !== current.outputDeviceId) {
          const resolved = next.backend === 'auto' ? /Mac/i.test(navigator.platform) ? 'coreaudio' : 'wasapi-shared' : next.backend
          next.alignmentOffsetMs = next.deviceAlignmentOffsets[`${resolved}|${next.inputDeviceId || 'default'}|${next.outputDeviceId || 'default'}`] ?? 0
        }
        return next
      }, () => callbacks.current.getChain(), () => mounted.current && !isRecordingLocked())
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
  const outputs = devices.filter(device => device.backend === backend && device.outputChannels > 0)
  const inputs = devices.filter(device => device.backend === backend && device.inputChannels > 0)
  const output = outputs.find(device => device.id === audio?.outputDeviceId) ?? outputs.find(device => device.defaultOutput)
  const channelCount = input?.inputChannels ?? 2
  const channels = Array.from({ length: channelCount }, (_, index) => [index]).concat(Array.from({ length: Math.floor(channelCount / 2) }, (_, index) => [index * 2, index * 2 + 1]))
  const channelValue = audio?.inputChannels.join(',') ?? '0'
  const sampleRates = [...new Set([0, ...(output?.sampleRates ?? [44100, 48000, 96000]), audio?.sampleRate ?? 0])].sort((a, b) => a - b)
  const buffers = [...new Set([0, 64, 128, 256, 512, 1024, 2048, audio?.bufferFrames ?? 0])].sort((a, b) => a - b)
  const disabled = busy || !audio || Boolean(recording)
  return <footer className="arsenal-footer">
    <div className="footer-device">
      <Headphones size={16} aria-hidden="true" />
      <label>后端<Select aria-label="实时音频后端" value={audio?.backend ?? 'auto'} disabled={disabled} onChange={event => { const backend = event.target.value as RecordingAudioSettings['backend']; void configure(current => ({ ...current, backend, inputDeviceId: '', outputDeviceId: '', inputChannels: [0], inputChannelMode: 'mono', sampleRate: 0 })) }}>
        <option value="auto">系统默认</option>{/Mac/i.test(navigator.platform) ? <option value="coreaudio">CoreAudio</option> : <><option value="asio">ASIO</option><option value="wasapi-shared">WASAPI 共享</option><option value="wasapi-exclusive">WASAPI 独占</option></>}
      </Select></label>
      <label>输入<Select aria-label="实时输入设备" value={audio?.inputDeviceId ?? ''} disabled={disabled || scanning} onChange={event => { const inputDeviceId = event.target.value; void configure(current => ({ ...current, inputDeviceId, inputChannels: [0], inputChannelMode: 'mono' })) }}>
        <option value="">系统默认输入</option>{audio?.inputDeviceId && !inputs.some(d=>d.id===audio.inputDeviceId) && <option value={audio.inputDeviceId} disabled>设备未连接</option>}{inputs.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}
      </Select></label>
      <label>输出<Select aria-label="实时输出设备" value={audio?.outputDeviceId ?? ''} disabled={disabled || scanning} onChange={event => { const outputDeviceId = event.target.value; void configure(current => ({ ...current, outputDeviceId, sampleRate: 0 })) }}>
        <option value="">系统默认输出</option>{audio?.outputDeviceId && !outputs.some(d=>d.id===audio.outputDeviceId) && <option value={audio.outputDeviceId} disabled>设备未连接</option>}{outputs.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}
      </Select></label>
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
    <span className="arsenal-level-meter" role="meter" aria-label="实时输入电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1,Math.max(0,...state.peak))*100)} title="输入"><span style={{width:`${Math.min(1,Math.max(0,...state.peak))*100}%`}}/></span>
    <span className="arsenal-level-meter" role="meter" aria-label="实时输出电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(peak * 100)}><span style={{ width: `${peak * 100}%` }} /></span>
    <small title="估算：驱动报告值 + 输入时钟缓冲 + 插件桥接与算法延迟；不代表声卡 AD/DA 实测往返延迟">{state.active ? `${state.mode === 'wet' ? '效果' : '干声'} · ${state.sampleRate / 1000} kHz · ${state.bufferFrames} frames · 估算 ${(state.latencyMs + (state.clock?.latencyFrames ?? 0) * 1000 / Math.max(1, state.sampleRate) + (state.mode === 'wet' ? state.plugin ? state.plugin.latencyFrames * 1000 / Math.max(1, state.sampleRate) : state.dspLatencyMs ?? 0 : 0)).toFixed(1)} ms` : '未监听'}{state.xruns > 0 ? ` · ${state.xruns} 次中断` : ''}</small>
    {state.active && state.diagnostics && <details className="audio-diagnostics"><summary>音频诊断</summary><div>
      <p>回调最大 {state.diagnostics.callbackMaxUs.toFixed(0)} μs；P99 ≤ {state.diagnostics.callbackP99UpperUs} μs；P99.9 ≤ {state.diagnostics.callbackP999UpperUs} μs</p>
      <p>实际周期 {state.diagnostics.minBufferFrames}–{state.diagnostics.maxBufferFrames} frames；回调超时 {state.diagnostics.callbackDeadlineMisses}</p>
      <p>驱动输入溢出 {state.diagnostics.inputOverflows}；输出欠载 {state.diagnostics.outputUnderflows}；PCM 欠载 {state.pcmUnderruns ?? 0}</p>
      <p>输入 FIFO {state.clock?.fifoFrames ?? 0} frames；采样比例 {(state.clock?.ratio ?? 1).toFixed(7)}；插件超时块 {state.plugin?.deadlineMisses ?? 0}</p>
      <p>限幅衰减 {state.diagnostics.limiterReductionDb.toFixed(1)} dB；无效样本 {state.diagnostics.invalidSamples}</p>
    </div></details>}
    {state.error && <small role="alert">{state.error}</small>}
  </span>
}
