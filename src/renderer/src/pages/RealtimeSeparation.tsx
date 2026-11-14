import { useEffect, useState } from 'react'
import { AudioLines, CheckCircle2, CircleAlert, Play, RefreshCw, Square } from 'lucide-react'
import { DEFAULT_REALTIME_CONFIG, REALTIME_STEMS, type RealtimeCapabilities, type RealtimeConfig, type RealtimeState } from '@shared/realtime-separation.js'
import './realtime-separation.css'

const names = { drums: '鼓', bass: '贝斯', vocals: '人声', guitar: '吉他', piano: '钢琴', other: '其他' }
const initial: RealtimeState = { phase: 'idle', config: DEFAULT_REALTIME_CONFIG, eligible: false, message: '正在读取设备与运行状态…', progress: 0, metrics: null, lastTest: null }

export default function RealtimeSeparation({ recording, onToast }: { recording: boolean; onToast(message: string): void }): React.JSX.Element {
  const api = window.bandbuddy.realtimeSeparation
  const [state, setState] = useState<RealtimeState>(initial)
  const [caps, setCaps] = useState<RealtimeCapabilities | null>(null)
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState<RealtimeConfig['stems']>(['drums'])
  const active = !['idle', 'failed'].includes(state.phase)
  const locked = active || pending
  const config = state.config

  useEffect(() => {
    let alive = true
    const accept = (value: RealtimeState): void => { if (alive) { setState(value); setSelected(value.config.stems) } }
    const unsubscribe = api.onChanged(accept)
    void api.state().then(accept).catch(error => onToast(String(error)))
    const refresh = (): void => { void api.capabilities().then(value => { if (alive) setCaps(value) }).catch(error => { if (alive) onToast(String(error)) }) }
    refresh()
    const devicesChanged = (): void => refresh()
    navigator.mediaDevices?.addEventListener('devicechange', devicesChanged)
    return () => { alive = false; unsubscribe(); navigator.mediaDevices?.removeEventListener('devicechange', devicesChanged); void api.stop().catch(() => {}) }
  }, [api, onToast])

  const act = async (operation: () => Promise<RealtimeState>): Promise<void> => {
    setPending(true)
    try { const value = await operation(); setState(value); setSelected(value.config.stems) }
    catch (error) { onToast(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }
  const configure = (patch: Partial<RealtimeConfig>): void => { void act(() => api.configure({ ...config, ...patch })) }
  const changeStems = (stem: RealtimeConfig['stems'][number]): void => {
    const next = selected.includes(stem) ? selected.filter(s => s !== stem) : [...selected, stem]
    setSelected(next)
    if (next.length) void act(() => api.mix({ stems: next, mode: config.mode }))
    else if (active) void act(() => api.stop()).then(() => setSelected([]))
  }
  const setup = (target: 'routing' | 'driver' | 'permission' | 'macDriver'): void => { void api.openSetup(target).catch(error => onToast(String(error))) }
  const metrics = state.metrics ?? state.lastTest?.metrics
  const inputs = caps?.devices.filter(d => d.input) ?? []
  const outputs = caps?.devices.filter(d => d.output && d.id !== config.source) ?? []
  const virtualInputs = inputs.filter(d => /virtual|cable|voicemeeter|blackhole|\bUU\b|虚拟|\bVAC\b/i.test(d.name))
  const canTest = !!caps?.ready && !caps.error && !recording && inputs.some(d => d.id === config.source) && outputs.some(d => d.id === config.output) && selected.length > 0 && !locked
  return <main className="page realtime-page">
    <div className="realtime-heading"><div><h1><AudioLines size={25} />实时分轨</h1><p>边播放电脑音频，边消除或独奏你选择的声部。</p></div><span className="realtime-backend">{config.backend !== 'auto' ? config.backend.toUpperCase() : caps?.device?.toUpperCase() ?? '检测运行环境'}</span></div>
    <section className="realtime-panel" aria-labelledby="realtime-devices">
      <div className="realtime-section-head"><h2 id="realtime-devices">音频来源与输出</h2><button disabled={locked} onClick={() => { setPending(true); void api.capabilities().then(setCaps).catch(error => onToast(String(error))).finally(() => setPending(false)) }}><RefreshCw size={15} />刷新设备</button></div>
      <div className="realtime-fields">
        <label>音频来源<select aria-label="音频来源" disabled={locked} value={config.source} onChange={e => configure({ source: e.target.value, output: e.target.value === config.output ? '' : config.output })}><option value="">选择系统音频或虚拟设备</option>{inputs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>输出设备<select aria-label="输出设备" disabled={locked} value={config.output} onChange={e => configure({ output: e.target.value })}><option value="">选择耳机或扬声器</option>{outputs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>采样率<select disabled={locked} value={config.rate} onChange={e => configure({ rate: Number(e.target.value) as 44100 | 48000 })}><option value={48000}>48 kHz</option><option value={44100}>44.1 kHz</option></select></label>
        <label>计算后端<select disabled={locked} value={config.backend} onChange={e => configure({ backend: e.target.value as RealtimeConfig['backend'] })}><option value="auto">自动选择</option><option value="cpu">CPU</option>{caps?.platform === 'win32' ? <option value="cuda">NVIDIA CUDA</option> : <option value="mps">Apple MPS</option>}</select></label>
      </div>
      {caps?.platform === 'win32' ? <div className="realtime-help"><p>将浏览器或播放器的输出设为虚拟音频设备，在这里选择该设备作为来源。输出请选择耳机或扬声器，并关闭虚拟设备的原声直通，避免重复播放。</p><button onClick={() => setup('routing')}>打开应用音量与设备设置</button><button onClick={() => setup('driver')}>获取虚拟音频设备</button></div> : <div className="realtime-help"><p>macOS 14.2 及以上可选择电脑系统音频，并授予系统音频录制权限。也可把播放器路由到已有虚拟设备，采样率需与设备一致。</p><button onClick={() => setup('permission')}>打开采集权限设置</button><button onClick={() => setup('macDriver')}>获取虚拟音频设备</button></div>}
      {caps?.error && <p className="realtime-warning" role="alert"><CircleAlert size={16} />{caps.error}</p>}
      {caps?.platform === 'win32' && caps.ready && <p className="realtime-note">{virtualInputs.length ? `识别到可能的虚拟设备：${virtualInputs.map(d => d.name).join('、')}。请核对播放器路由。` : '未识别到常见虚拟音频设备。如已安装其他驱动，请在来源列表中手动选择；尚未安装可使用上方安装来源。'}</p>}
      <h2 className="realtime-profile-title">性能档位</h2>
      <div className="realtime-profiles" role="group" aria-label="性能档位">{(['smooth', 'lowLatency'] as const).map(profile => <button key={profile} aria-pressed={config.profile === profile} disabled={locked} onClick={() => configure({ profile })}><strong>{profile === 'smooth' ? '流畅' : '低延迟'}</strong><span>设备链路延迟估计 ≤ {profile === 'smooth' ? '1000' : '300'} ms</span></button>)}</div>
    </section>
    <section className="realtime-panel" aria-labelledby="realtime-stems"><h2 id="realtime-stems">选择声部</h2>
      <div className="realtime-modes" role="group" aria-label="分轨模式">{(['remove', 'solo'] as const).map(mode => <button key={mode} aria-pressed={config.mode === mode} disabled={pending} onClick={() => { void act(() => api.mix({ stems: selected.length ? selected : config.stems, mode })) }}>{mode === 'remove' ? '消除所选' : '只听所选'}</button>)}</div>
      <div className="realtime-stems">{REALTIME_STEMS.map(stem => <label key={stem} className={selected.includes(stem) ? 'selected' : ''}><input type="checkbox" checked={selected.includes(stem)} disabled={pending} onChange={() => changeStems(stem)} /><span>{names[stem]}</span></label>)}</div>
      {selected.length === 0 && <p className="realtime-warning">请至少选择一个声部。</p>}
    </section>
    <section className="realtime-panel" aria-labelledby="realtime-performance"><h2 id="realtime-performance">性能测试</h2>
      <p className="realtime-note">模型预热后测试 60 秒完整音频链路，期间会播放低音量测试音，请先暂停来源设备上的其他播放。通过后才能开始；更换设备、采样率、后端或档位需要重测。</p>
      {metrics && <dl className="realtime-metrics"><div><dt>单块处理 P99</dt><dd>{metrics.p99Ms.toFixed(1)} ms</dd></div><div><dt>最长单块耗时</dt><dd>{metrics.maxMs.toFixed(1)} ms</dd></div><div><dt>设备链路延迟估计</dt><dd>{metrics.latencyMs.toFixed(0)} ms</dd></div><div><dt>欠载／丢包</dt><dd>{metrics.underruns} / {metrics.inputDrops + metrics.overflows}</dd></div></dl>}
      {!state.metrics && state.lastTest && <p className="realtime-note">上次测试于 {new Date(state.lastTest.at).toLocaleString()}，仅供参考，本次启动需要重新测试。</p>}
      <div className="realtime-status" role="status">{state.eligible && <CheckCircle2 size={18} />}<span>{state.message}</span></div>
      {state.phase === 'running' && !!metrics?.underruns && <p className="realtime-warning" role="alert">已出现 {metrics.underruns} 次输出欠载，已做短淡化。10 秒内累计 3 次会自动停止并要求重测。</p>}
      {state.phase === 'testing' && <progress aria-label="性能测试进度" max={1} value={state.progress} />}
      {recording && <p className="realtime-warning">录音进行中，请先停止录音再测试或开始实时分轨。</p>}
      <div className="realtime-actions"><button disabled={!canTest} onClick={() => { void act(() => api.test()) }}>运行性能测试</button>{active ? <button disabled={state.phase === 'stopping'} onClick={() => { void act(() => api.stop()) }}><Square size={16} />{state.phase === 'testing' || state.phase === 'warming' || state.phase === 'waiting' ? '取消' : '停止'}</button> : <button className="primary" disabled={!state.eligible || !canTest} onClick={() => { void act(() => api.start()) }}><Play size={16} />开始实时分轨</button>}</div>
      <p className="realtime-note">离开此页面会停止处理。运行期间会持续监测负载，超出实时播放条件时自动停止。</p>
    </section>
  </main>
}
