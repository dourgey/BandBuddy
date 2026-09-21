import { useEffect, useMemo, useState } from 'react'
import { Cable, ChevronDown, ChevronLeft, ChevronRight, Gauge, Headphones, Plus, Save, Search, SlidersHorizontal, Upload, Volume2, X } from 'lucide-react'
import { defaultEffectChain, effectChainSchema, WHITEBOX_DEVICES, type ArsenalPreset, type EffectBlock, type EffectChainSnapshot, type MonitorMode } from '@shared/arsenal.js'
import { WhiteboxControls } from '../arsenal/WhiteboxControls.js'
import './arsenal.css'

const labels: Record<EffectBlock, string> = { drive: '白盒单块', amp: 'AMP + CAB', eq: 'EQ', delay: 'DELAY', reverb: 'REVERB' }
const colors: Record<EffectBlock, string> = { drive: '#587358', amp: '#252321', eq: '#d6d3cb', delay: '#efe2cf', reverb: '#286a9a' }

export function ArsenalPage({ onToast }: { onToast(message: string): void }): React.JSX.Element {
  const [presets, setPresets] = useState<ArsenalPreset[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chain, setChain] = useState<EffectChainSnapshot>(defaultEffectChain)
  const [selectedBlock, setSelectedBlock] = useState<EffectBlock>('amp')
  const [monitor, setMonitor] = useState<MonitorMode>('off')
  const [search, setSearch] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => { void window.bandbuddy.arsenal.list().then((state) => { setPresets(state.presets); const first = state.presets[0]; if (first) { setSelectedId(first.id); setChain(effectChainSchema.parse(first.chain)) } }) }, [])
  useEffect(() => {
    let mounted = true
    void window.bandbuddy.arsenal.monitorState().then(s => { if (mounted) setMonitor(s.active ? s.mode : 'off') }).catch(() => undefined)
    const unsubscribe = window.bandbuddy.arsenal.onMonitor(s => { if (mounted) setMonitor(s.active ? s.mode : 'off') })
    return () => { mounted = false; unsubscribe() }
  }, [])
  useEffect(() => {
    if (monitor === 'off') return
    let stale = false
    const timer = window.setTimeout(() => {
      void window.bandbuddy.arsenal.monitor({ mode: monitor, chain }).catch(error => {
        if (!stale) onToast(error instanceof Error ? error.message : '效果更新失败')
      })
    }, 60)
    return () => { stale = true; window.clearTimeout(timer) }
  }, [chain, monitor, onToast])
  const visible = useMemo(() => presets.filter((p) => p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [presets, search])
  const update = (patch: Partial<EffectChainSnapshot>): void => { setChain((current) => ({ ...current, ...patch })); setDirty(true) }
  const selectPreset = (preset: ArsenalPreset): void => { setSelectedId(preset.id); setChain(effectChainSchema.parse(preset.chain)); setDirty(false) }
  const save = async (asNew = false): Promise<void> => {
    try {
      const current = presets.find((p) => p.id === selectedId)
      const result = await window.bandbuddy.arsenal.savePreset({ id: asNew ? undefined : selectedId ?? undefined, name: asNew || !current ? `${current?.name ?? '新预设'} 副本` : current.name, chain })
      setPresets((items) => [result, ...items.filter((p) => p.id !== result.id)]); setSelectedId(result.id); setDirty(false); onToast('预设已保存')
    } catch (error) { onToast(error instanceof Error ? error.message : '预设保存失败') }
  }
  const changeMonitor = async (mode: MonitorMode): Promise<void> => {
    setLoading(true)
    try { await window.bandbuddy.arsenal.monitor({ mode, chain }); setMonitor(mode) } catch (error) { onToast(error instanceof Error ? error.message : '监听启动失败') } finally { setLoading(false) }
  }
  const importAsset = async (kind: 'nam' | 'ir'): Promise<void> => {
    try { const asset = await window.bandbuddy.arsenal.importAsset(kind); if (asset) { onToast(`${kind === 'nam' ? 'NAM 音色' : '箱体 IR'} 已导入`); const state = await window.bandbuddy.arsenal.list(); setPresets(state.presets) } } catch (error) { onToast(error instanceof Error ? error.message : '导入失败') }
  }
  const toggle = (block: EffectBlock): void => {
    if (block === 'drive') update({ drive: { ...chain.drive, enabled: !chain.drive.enabled } })
    if (block === 'amp') update({ amp: { ...chain.amp, enabled: !chain.amp.enabled } })
    if (block === 'eq') update({ eq: { ...chain.eq, enabled: !chain.eq.enabled } })
    if (block === 'delay') update({ delay: { ...chain.delay, enabled: !chain.delay.enabled } })
    if (block === 'reverb') update({ reverb: { ...chain.reverb, enabled: !chain.reverb.enabled } })
  }
  const moveBlock = (direction: -1 | 1): void => {
    const index = chain.order.indexOf(selectedBlock); const next = index + direction
    if (index < 0 || next < 0 || next >= chain.order.length) return
    const order = [...chain.order]; [order[index], order[next]] = [order[next]!, order[index]!]; update({ order })
  }
  const enabled = (block: EffectBlock): boolean => block === 'drive' ? chain.drive.enabled : block === 'amp' ? chain.amp.enabled : block === 'eq' ? chain.eq.enabled : block === 'delay' ? chain.delay.enabled : chain.reverb.enabled
  return <main className="arsenal-page">
    <aside className="arsenal-sidebar">
      <div className="arsenal-sidebar-head"><div><h1>军火库</h1><p>我的声音，我的装备。</p></div><button aria-label="收起预设"><ChevronLeft size={17} /></button></div>
      <label className="arsenal-search"><Search size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索预设..." /></label>
      <div className="arsenal-preset-list">{visible.map((preset) => <button key={preset.id} className={`arsenal-preset ${preset.id === selectedId ? 'selected' : ''}`} onClick={() => selectPreset(preset)}><span className="preset-thumb" style={{ background: preset.id === selectedId ? 'linear-gradient(145deg,#9c7a55,#382d23)' : 'linear-gradient(145deg,#676159,#25221f)' }} /><span><b>{preset.name}</b><small>{preset.chain.drive.enabled ? preset.chain.drive.device.toUpperCase() : preset.chain.amp.enabled ? 'NAM' : '干声'} · {preset.chain.delay.enabled ? '延迟' : '直达'} · {preset.chain.reverb.enabled ? '空间' : '无混响'}</small></span><i>⋮</i></button>)}</div>
      <div className="arsenal-sidebar-actions"><button onClick={() => { setSelectedId(null); setChain(defaultEffectChain()); setDirty(true) }}><Plus size={16} />新建预设</button><button onClick={() => void save()} disabled={!dirty}><Save size={16} />保存{dirty && <em>未保存</em>}</button><button onClick={() => void save(true)}><SlidersHorizontal size={16} />另存为</button></div>
    </aside>
    <section className={`arsenal-workspace ${selectedBlock === 'drive' ? 'editing-whitebox' : ''}`}>
      <header className="arsenal-toolbar"><div><span className="arsenal-kicker">SIGNAL WORKSHOP</span><h2>{presets.find((p) => p.id === selectedId)?.name ?? '新预设'}{dirty && <sup>未保存</sup>}</h2></div><div className="arsenal-toolbar-actions"><button className="outline-button compact" onClick={() => setSelectedBlock('drive')}>白盒设备</button><button className="outline-button compact" onClick={() => void importAsset('nam')}><Upload size={14} />导入 NAM</button><button className="outline-button compact" onClick={() => void importAsset('ir')}><Upload size={14} />导入 IR</button></div></header>
      <div className="arsenal-studio">
        <div className="studio-amp" onClick={() => setSelectedBlock('amp')} role="button" tabIndex={0} aria-label="打开箱头和箱体"><img className="amp-head" src="/arsenal/amp-head.png" alt="NAM 箱头" draggable="false" /><img className="amp-cab" src="/arsenal/amp-cab.png" alt="箱体与 IR" draggable="false" /></div>
        <div className="studio-cables"><Cable size={24} /><Cable size={18} /></div>
        <div className="studio-pedals">{(['eq', 'delay', 'reverb'] as EffectBlock[]).map((block) => <button key={block} className={`studio-pedal pedal-${block} ${selectedBlock === block ? 'focused' : ''} ${!enabled(block) ? 'bypassed' : ''}`} onClick={() => setSelectedBlock(block)} aria-label={`编辑${labels[block]}`}><img className="pedal-asset" src={`/arsenal/${block}.png`} alt={labels[block]} draggable="false" /><span className="pedal-switch" role="switch" aria-label={`${labels[block]} ${enabled(block) ? '旁通' : '开启'}`} aria-checked={enabled(block)} onClick={(e) => { e.stopPropagation(); toggle(block) }} /></button>)}</div>
        <div className="studio-sign">GOOD<br />MUSIC<br /><small>BETTER<br />PRACTICE</small></div>
      </div>
      <div className="arsenal-chain"><div className="chain-node input"><Volume2 size={15} />INPUT</div>{chain.order.map((block, index) => <span className="chain-step" key={block}><ChevronRight size={14} /><button className={`chain-node ${enabled(block) ? 'on' : ''} ${selectedBlock === block ? 'active' : ''}`} onClick={() => setSelectedBlock(block)} style={{ borderColor: colors[block] }}>{block === 'drive' ? WHITEBOX_DEVICES.find(d => d.id === chain.drive.device)?.name.split(' · ')[0] : labels[block]}<small>{enabled(block) ? 'ON' : 'BYPASS'}</small></button>{index === chain.order.length - 1 && <ChevronRight size={14} />}</span>)}<div className="chain-node output">◯ OUTPUT</div></div>
      <div className="arsenal-editor"><div className="editor-head"><div><b>{labels[selectedBlock]}</b><small>{selectedBlock === 'drive' ? '经典电路原型 · 实验版' : selectedBlock === 'amp' ? 'Neural Amp Modeler · Architecture 2' : '踩下踏板调整参数'}</small></div><div className="editor-actions"><button className="move-button" onClick={() => moveBlock(-1)} aria-label="效果前移">←</button><button className="move-button" onClick={() => moveBlock(1)} aria-label="效果后移">→</button><button className={`power-toggle ${enabled(selectedBlock) ? 'on' : ''}`} onClick={() => toggle(selectedBlock)}><Gauge size={15} />{enabled(selectedBlock) ? '已开启' : '旁通'}</button></div></div><EditorControls block={selectedBlock} chain={chain} update={update} /></div>
      <footer className="arsenal-footer"><div className="footer-device"><Headphones size={16} /><b>输入通道</b><select defaultValue="1"><option value="1">1</option><option value="2">2</option></select><select defaultValue="128"><option value="64">64 frames</option><option value="128">128 frames</option><option value="256">256 frames</option></select><span>48 kHz</span></div><div className="footer-monitor"><span>监听</span>{(['off', 'dry', 'wet'] as MonitorMode[]).map((mode) => <button key={mode} disabled={loading} className={monitor === mode ? 'active' : ''} onClick={() => void changeMonitor(mode)}>{mode === 'off' ? '关闭' : mode === 'dry' ? '干声' : '效果'}</button>)}<i className="level-bars">▮▮▮▮▮▮▮▮▮▮▯▯▯▯</i><small>{monitor === 'wet' ? '效果监听中' : '未监听'}</small></div></footer>
    </section>
  </main>
}

function EditorControls({ block, chain, update }: { block: EffectBlock; chain: EffectChainSnapshot; update(patch: Partial<EffectChainSnapshot>): void }): React.JSX.Element {
  if (block === 'drive') return <WhiteboxControls value={chain.drive} onChange={drive => update({ drive })} />
  if (block === 'amp') return <div className="control-grid amp-editor"><div className="asset-drop"><Upload size={18} /><b>{chain.amp.assetId ? '已加载 NAM 音色' : '尚未导入 NAM 音色'}</b><small>从顶部导入 .nam 文件</small></div><Knob label="输入增益" value={chain.inputGainDb} min={-24} max={12} step={.5} onChange={(v) => update({ inputGainDb: v })} /><Knob label="输出音量" value={chain.outputGainDb} min={-24} max={12} step={.5} onChange={(v) => update({ outputGainDb: v })} /><label className="quality-select">模型质量<select value={chain.amp.quality} onChange={(e) => update({ amp: { ...chain.amp, quality: e.target.value as 'full' | 'lite' } })}><option value="full">Full</option><option value="lite">Lite</option></select></label></div>
  if (block === 'eq') return <div className="eq-editor">{chain.eq.bands.map((value, i) => <label key={i}><input type="range" min={-15} max={15} step={.5} value={value} onChange={(e) => update({ eq: { ...chain.eq, bands: chain.eq.bands.map((v, n) => n === i ? Number(e.target.value) : v) } })} /><b>{value > 0 ? '+' : ''}{value.toFixed(1)}</b><small>{[100, 200, 400, 800, 1600, 3200, 6400][i]} Hz</small></label>)}</div>
  if (block === 'delay') return <div className="control-grid"><Knob label="时间 ms" value={chain.delay.timeMs} min={1} max={2000} step={1} suffix=" ms" onChange={(v) => update({ delay: { ...chain.delay, timeMs: v } })} /><Knob label="反馈" value={chain.delay.feedback * 100} min={0} max={95} step={1} suffix="%" onChange={(v) => update({ delay: { ...chain.delay, feedback: v / 100 } })} /><Knob label="混合" value={chain.delay.mix * 100} min={0} max={100} step={1} suffix="%" onChange={(v) => update({ delay: { ...chain.delay, mix: v / 100 } })} /><label className="quality-select">Tap Tempo <button className="tap-button" onClick={() => update({ delay: { ...chain.delay, bpm: Math.round(60000 / chain.delay.timeMs) } })}>当前 {chain.delay.bpm} BPM</button></label></div>
  return <div className="control-grid"><Knob label="衰减 s" value={chain.reverb.decay} min={.1} max={10} step={.1} suffix=" s" onChange={(v) => update({ reverb: { ...chain.reverb, decay: v } })} /><Knob label="预延迟 ms" value={chain.reverb.preDelayMs} min={0} max={200} step={1} suffix=" ms" onChange={(v) => update({ reverb: { ...chain.reverb, preDelayMs: v } })} /><Knob label="混合" value={chain.reverb.mix * 100} min={0} max={100} step={1} suffix="%" onChange={(v) => update({ reverb: { ...chain.reverb, mix: v / 100 } })} /><Knob label="阻尼" value={chain.reverb.damping * 100} min={0} max={100} step={1} suffix="%" onChange={(v) => update({ reverb: { ...chain.reverb, damping: v / 100 } })} /></div>
}
function Knob({ label, value, min, max, step, suffix = ' dB', onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange(value: number): void }): React.JSX.Element { return <label className="knob-control"><span className="knob" style={{ '--angle': `${-135 + ((value - min) / (max - min)) * 270}deg` } as React.CSSProperties}><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></span><b>{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</b><small>{label}</small></label> }
