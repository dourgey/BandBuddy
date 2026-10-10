import { RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createDefaultSongEq, EQ_FREQUENCIES, EQ_MAX_NODES, type EqNode, type SongEqState } from '@shared/equalizer.js'
import type { MultiTrackAudioEngine } from '../audio-engine.js'
import type { PracticePersistence } from '../practice-persistence.js'
import { usePlayerStore } from '../player-store.js'
import './equalizer.css'

const WIDTH = 800, HEIGHT = 280, LEFT = 44, RIGHT = 776, TOP = 22, BOTTOM = 244
const hzX = (hz: number): number => LEFT + Math.log10(hz / 20) / 3 * (RIGHT - LEFT)
const gainY = (gain: number): number => TOP + (12 - gain) / 24 * (BOTTOM - TOP)
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const labelHz = (value: number): string => value >= 1000 ? `${value / 1000}k` : String(value)
const fixed = (value: number): number => Math.round(value * 10) / 10

function NumberField({ label, value, min, max, step = 0.1, onChange, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void; onCommit(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(fixed(value)))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(String(fixed(value))) }, [value])
  return <input type="number" aria-label={label} min={min} max={max} step={step} value={draft}
    onFocus={() => { focused.current = true }}
    onChange={event => {
      setDraft(event.target.value)
      if (event.target.value.trim() && Number.isFinite(event.target.valueAsNumber)) onChange(clamp(event.target.valueAsNumber, min, max))
    }}
    onBlur={() => { focused.current = false; setDraft(String(fixed(value))); onCommit() }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}

export function EqWindow({ engine, persistence, locked, onCommit, onClose }: {
  engine: MultiTrackAudioEngine; persistence: PracticePersistence; locked: boolean; onCommit(): Promise<void>; onClose(): void
}): React.JSX.Element | null {
  const eq = usePlayerStore(state => state.practice?.eq)
  const song = usePlayerStore(state => state.song)
  const patchPractice = usePlayerStore(state => state.patchPractice)
  const [selectedId, setSelectedId] = useState<string | null>(eq?.nodes[0]?.id ?? null)
  const status = useSyncExternalStore(persistence.subscribe, () => persistence.getStatus(song?.id ?? ''))
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), curve = useRef<SVGPathElement>(null)
  const compensation = useRef<HTMLElement>(null)
  const drag = useRef<string | null>(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  const commit = (): void => { void onCommit().catch(() => undefined) }
  const update = (patch: Partial<SongEqState>, enable = true): void => {
    const current = usePlayerStore.getState().practice?.eq
    if (!current || locked) return
    patchPractice({ eq: { ...current, ...(enable ? { enabled: true } : {}), ...patch } })
  }
  const editNode = (id: string, patch: Partial<EqNode>): void => {
    const current = usePlayerStore.getState().practice?.eq
    if (current) update({ nodes: current.nodes.map(node => node.id === id ? { ...node, ...patch } : node) })
  }

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.dialog-overlay[data-dialog-open="true"], [role="dialog"][aria-modal="true"]')) return
      event.preventDefault(); event.stopImmediatePropagation(); closeRef.current()
    }
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('keydown', key, true); previousFocus?.focus() }
  }, [])

  useEffect(() => {
    const element = root.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (locked || !event.deltaY) return
      const target = event.target instanceof Element ? event.target : null
      const band = target?.closest<HTMLElement>('[data-eq-band]'), node = target?.closest<SVGElement>('[data-eq-node]')
      if (!band && !node) return
      event.preventDefault()
      const current = usePlayerStore.getState().practice?.eq
      if (!current) return
      const direction = event.deltaY < 0 ? 1 : -1
      if (band) {
        const index = Number(band.dataset.eqBand)
        patchPractice({ eq: { ...current, enabled: true, graphicGains: current.graphicGains.map((gain, at) => at === index ? fixed(clamp(gain + direction * 0.1, -12, 12)) : gain) } })
      } else {
        patchPractice({ eq: { ...current, enabled: true, nodes: current.nodes.map(value => value.id === node!.dataset.eqNode ? { ...value, q: fixed(clamp(value.q + direction * 0.1, 0.2, 12)) } : value) } })
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [locked, patchPractice])

  useEffect(() => {
    engine.setEqVisualizationActive(true)
    let frame = 0, lastFrame = -Infinity
    const shown = new Float32Array(512).fill(-100)
    const draw = (now: number): void => {
      frame = requestAnimationFrame(draw)
      if (now - lastFrame < 1000 / 30) return
      lastFrame = now
      const data = engine.getEqVisualData(), context = canvas.current?.getContext('2d')
      if (!context || !data) return
      const ratio = window.devicePixelRatio || 1
      const pixels = Math.round((canvas.current?.clientWidth ?? WIDTH) * ratio)
      if (canvas.current!.width !== pixels) { canvas.current!.width = pixels; canvas.current!.height = Math.round(pixels / WIDTH * HEIGHT) }
      context.setTransform(pixels / WIDTH, 0, 0, pixels / WIDTH, 0, 0)
      context.clearRect(0, 0, WIDTH, HEIGHT)
      const tint = getComputedStyle(root.current!).getPropertyValue('--warning').trim() || '#b6945d'
      context.fillStyle = tint; context.globalAlpha = 0.2
      context.beginPath(); context.moveTo(LEFT, BOTTOM)
      for (let index = 0; index < shown.length; index++) {
        const frequency = data.frequencies[index]!
        const bin = Math.min(data.spectrumDb.length - 1, Math.round(frequency / data.sampleRate * (data.spectrumDb.length * 2)))
        const target = data.spectrumDb[bin] ?? -100
        shown[index] = Math.max(target, shown[index]! - 3)
        context.lineTo(hzX(frequency), BOTTOM - clamp((shown[index]! + 100) / 100, 0, 1) * (BOTTOM - TOP))
      }
      context.lineTo(RIGHT, BOTTOM); context.closePath(); context.fill()
      const path = Array.from(data.responseDb, (gain, index) => `${index ? 'L' : 'M'}${hzX(data.frequencies[index]!).toFixed(2)},${gainY(gain).toFixed(2)}`).join(' ')
      curve.current?.setAttribute('d', path)
      if (compensation.current) compensation.current.textContent = `${data.compensationDb.toFixed(1)} dB`
    }
    frame = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame); engine.setEqVisualizationActive(false) }
  }, [engine])

  if (!eq || !song) return null
  const selected = eq.nodes.find(node => node.id === selectedId)
  const point = (event: { clientX: number; clientY: number }, svg: SVGSVGElement): { frequency: number; gainDb: number } => {
    const bounds = svg.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width * WIDTH, y = (event.clientY - bounds.top) / bounds.height * HEIGHT
    return { frequency: fixed(20 * 1000 ** clamp((x - LEFT) / (RIGHT - LEFT), 0, 1)), gainDb: fixed(clamp(12 - (y - TOP) / (BOTTOM - TOP) * 24, -12, 12)) }
  }
  const remove = (): void => {
    if (!selected || locked) return
    update({ nodes: eq.nodes.filter(node => node.id !== selected.id) }); setSelectedId(null); commit()
  }
  const reset = (): void => {
    const defaults = createDefaultSongEq()
    update(eq.mode === 'graphic' ? { graphicGains: defaults.graphicGains } : { nodes: defaults.nodes }, false)
    setSelectedId(defaults.nodes[0]!.id); commit()
  }

  return createPortal(<section ref={root} className="song-eq-window" role="dialog" aria-modal="false" aria-labelledby="song-eq-title" aria-describedby="song-eq-scope" data-dialog-open="true" tabIndex={-1}
    onKeyDown={event => {
      if (eq.mode === 'parametric' && event.key === 'Delete' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); remove() }
    }}>
    <header className="song-eq-header">
      <div><span className="song-eq-eyebrow">歌曲均衡器</span><h2 id="song-eq-title">{song.title}<small>EQ</small></h2></div>
      <label className="song-eq-enable"><span>{eq.enabled ? '已启用' : '已旁路'}</span><input type="checkbox" role="switch" aria-label="启用歌曲 EQ" checked={eq.enabled} disabled={locked} onChange={event => { update({ enabled: event.target.checked }, false); commit() }} /><i /></label>
      <button className="song-eq-close" aria-label="关闭歌曲 EQ" onClick={onClose}><X size={19} /></button>
    </header>
    <div className="song-eq-toolbar">
      <div className="song-eq-mode"><span className={eq.mode === 'graphic' ? 'selected' : ''}>固定频段</span><input type="checkbox" role="switch" aria-label="自由曲线模式" checked={eq.mode === 'parametric'} disabled={locked} onChange={event => { update({ mode: event.target.checked ? 'parametric' : 'graphic' }, false); commit() }} /><span className={eq.mode === 'parametric' ? 'selected' : ''}>自由曲线</span></div>
      <button disabled={locked} className="song-eq-reset" onClick={reset}><RotateCcw size={14} />重置当前模式</button>
    </div>
    <div className={`song-eq-graph ${eq.enabled ? '' : 'is-bypassed'}`}>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" />
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role={eq.mode === 'parametric' ? 'group' : 'img'} aria-label="EQ 响应曲线与实时频谱" onPointerMove={event => {
        if (drag.current) editNode(drag.current, point(event, event.currentTarget))
      }} onPointerUp={() => { if (drag.current) { drag.current = null; commit() } }} onPointerCancel={() => { drag.current = null; commit() }} onDoubleClick={event => {
        if (eq.mode !== 'parametric' || eq.nodes.length >= EQ_MAX_NODES || locked) return
        const bounds = event.currentTarget.getBoundingClientRect(), x = (event.clientX - bounds.left) / bounds.width * WIDTH, y = (event.clientY - bounds.top) / bounds.height * HEIGHT
        if (x < LEFT || x > RIGHT || y < TOP || y > BOTTOM) return
        const node: EqNode = { id: crypto.randomUUID(), ...point(event, event.currentTarget), q: 1 }
        update({ nodes: [...eq.nodes, node] }); setSelectedId(node.id); commit()
      }}>
        <defs><clipPath id="song-eq-clip"><rect x={LEFT} y={TOP} width={RIGHT - LEFT} height={BOTTOM - TOP} /></clipPath></defs>
        {[12, 6, 0, -6, -12].map(gain => <g key={gain}><line className={gain === 0 ? 'eq-zero-line' : 'eq-grid-line'} x1={LEFT} x2={RIGHT} y1={gainY(gain)} y2={gainY(gain)} /><text x={LEFT - 9} y={gainY(gain) + 4} textAnchor="end">{gain > 0 ? '+' : ''}{gain}</text></g>)}
        {[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map(hz => <g key={hz}><line className="eq-grid-line" x1={hzX(hz)} x2={hzX(hz)} y1={TOP} y2={BOTTOM} /><text x={hzX(hz)} y={BOTTOM + 22} textAnchor="middle">{labelHz(hz)}</text></g>)}
        <path ref={curve} d={`M${LEFT},${gainY(0)} L${RIGHT},${gainY(0)}`} className="eq-response-line" clipPath="url(#song-eq-clip)" />
        {eq.mode === 'parametric' && eq.nodes.map((node, index) => <g key={node.id} data-eq-node={node.id} className={`eq-node ${selectedId === node.id ? 'selected' : ''}`} transform={`translate(${hzX(node.frequency)},${gainY(node.gainDb)})`}
          role="button" tabIndex={locked ? -1 : 0} aria-label={`频段 ${index + 1}，${node.frequency} Hz，${node.gainDb} dB，Q ${node.q}`}
          onFocus={() => setSelectedId(node.id)} onPointerDown={event => { if (locked) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = node.id; setSelectedId(node.id) }}
          onDoubleClick={event => { event.stopPropagation(); editNode(node.id, { gainDb: 0 }); commit() }}
          onKeyDown={event => {
            const fine = event.shiftKey ? 0.1 : 0.5
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); editNode(node.id, { gainDb: fixed(clamp(node.gainDb + (event.key === 'ArrowUp' ? fine : -fine), -12, 12)) }) }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); editNode(node.id, { frequency: fixed(clamp(node.frequency * (event.key === 'ArrowRight' ? 1.02 : 1 / 1.02), 20, 20000)) }) }
          }} onKeyUp={event => { if (event.key.startsWith('Arrow')) commit() }}>
          <circle className="eq-node-hit" r={17} /><circle className="eq-node-dot" r={8} /><text y={-16} textAnchor="middle">{index + 1}</text>
        </g>)}
      </svg>
      <div className="song-eq-legend"><span>实时频谱</span><span>EQ 响应</span><small>dB / Hz</small></div>
    </div>
    <fieldset disabled={locked} className="song-eq-controls">
      {eq.mode === 'graphic' ? <div className="song-eq-bands">{EQ_FREQUENCIES.map((frequency, index) => <div key={frequency} className="song-eq-band" data-eq-band={index}>
        <span>{labelHz(frequency)}<small>Hz</small></span>
        <input type="range" aria-label={`${frequency} Hz 增益`} min={-12} max={12} step={0.1} value={eq.graphicGains[index]} onChange={event => update({ graphicGains: eq.graphicGains.map((gain, at) => at === index ? Number(event.target.value) : gain) })} onDoubleClick={() => { update({ graphicGains: eq.graphicGains.map((gain, at) => at === index ? 0 : gain) }); commit() }} onPointerUp={commit} onKeyUp={commit} />
        <NumberField label={`${frequency} Hz 增益数值`} min={-12} max={12} value={eq.graphicGains[index]!} onChange={value => update({ graphicGains: eq.graphicGains.map((gain, at) => at === index ? value : gain) })} onCommit={commit} />
      </div>)}</div> : <div className="song-eq-node-controls">
        {selected ? <><span className="song-eq-node-label">频段 {eq.nodes.indexOf(selected) + 1}</span><label>频率 <NumberField label="选中频段频率" value={selected.frequency} min={20} max={20000} step={1} onChange={frequency => editNode(selected.id, { frequency })} onCommit={commit} /><small>Hz</small></label><label>增益 <NumberField label="选中频段增益" value={selected.gainDb} min={-12} max={12} onChange={gainDb => editNode(selected.id, { gainDb })} onCommit={commit} /><small>dB</small></label><label>Q <NumberField label="选中频段 Q" value={selected.q} min={0.2} max={12} onChange={q => editNode(selected.id, { q })} onCommit={commit} /></label><button className="song-eq-delete" aria-label="删除选中频段" onClick={remove}><Trash2 size={16} /></button></> : <span className="song-eq-no-node">选择节点编辑参数，或双击曲线区域添加频段</span>}
        <small className="song-eq-node-count">{eq.nodes.length} / {EQ_MAX_NODES} 频段</small>
      </div>}
    </fieldset>
    <p className="song-eq-hint">{eq.mode === 'graphic' ? '拖动或滚轮微调 · 双击滑杆归零' : '拖动节点调节频率与增益 · 滚轮调 Q · 双击空白处添加 · Delete 删除'}<span>两种模式分别记忆</span></p>
    <footer className="song-eq-footer"><div><p id="song-eq-scope">作用于伴奏与录音预听 · 仅用于练习播放</p><span>增益补偿 <b ref={compensation}>0.0 dB</b></span></div><div className={`song-eq-save ${status}`} role="status">{status === 'saving' ? '保存中…' : status === 'error' ? <><span>保存失败</span><button onClick={commit}>重试</button></> : '已保存到此歌曲'}</div></footer>
  </section>, document.body)
}
