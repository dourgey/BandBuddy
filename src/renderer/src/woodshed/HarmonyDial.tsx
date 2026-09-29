import { useEffect, useId, useRef, useState } from 'react'
import { CIRCLE, mod, parseNote } from './theory.js'
import { harmonyRootName, keyName, keySignature } from './harmony.js'

const point = (radius: number, angle: number): [number, number] => [250 + radius * Math.sin(angle * Math.PI / 180), 250 - radius * Math.cos(angle * Math.PI / 180)]
function wedge(inner: number, outer: number, angle: number): string {
  const a = point(outer, angle - 15), b = point(outer, angle + 15), c = point(inner, angle + 15), d = point(inner, angle - 15)
  return `M${a} A${outer},${outer} 0 0 1 ${b} L${c} A${inner},${inner} 0 0 0 ${d} Z`
}
export function HarmonyDial({ root, minor, activeRoot, onRoot, onMinor }: {
  root: number; minor: boolean; activeRoot: number | null; onRoot: (root: number) => void; onMinor: (minor: boolean) => void
}): React.JSX.Element {
  const id = useId().replaceAll(':', '')
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const element = svg.current
    const preventScroll = (event: WheelEvent): void => { event.preventDefault() }
    element?.addEventListener('wheel',preventScroll,{passive:false})
    return () => element?.removeEventListener('wheel',preventScroll)
  },[])
  const majorRoot = minor ? mod(root + 3) : root
  const selectedIndex = CIRCLE.findIndex(([name]) => mod(parseNote(`${name}4`)!) === majorRoot)
  const drag = useRef<{ angle: number; rotation: number; moved: boolean; last: number; velocity: number; time: number } | null>(null)
  const [rotation, setRotation] = useState<number | null>(null)
  const wheelTime = useRef(0)
  const suppressClick = useRef(false)
  const previousRotation = useRef(-selectedIndex * 30)
  const targetRotation = previousRotation.current + mod(-selectedIndex * 30 - previousRotation.current + 180,360) - 180
  previousRotation.current = rotation ?? targetRotation
  const current = rotation ?? targetRotation
  const angleAt = (event: React.PointerEvent<SVGSVGElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.atan2(event.clientX - rect.left - rect.width / 2, -(event.clientY - rect.top - rect.height / 2)) * 180 / Math.PI
  }
  const chooseIndex = (index: number): void => {
    const value = CIRCLE[mod(index, 12)]!
    onRoot(mod(parseNote(`${value[0]}4`)! + (minor ? 9 : 0)))
  }
  const finish = (cancel = false): void => {
    if (!drag.current) return
    const state = drag.current
    if (state.moved && !cancel) {
      suppressClick.current = true
      chooseIndex(-Math.round((current + Math.max(-18, Math.min(18, state.velocity * 60))) / 30))
    }
    drag.current = null; setRotation(null)
  }
  return <section className="he-dial-panel" aria-label="五度圈和声控制器">
    <div className="he-engraving"><span>CIRCLE OF<br />FIFTHS</span><span>KEYS CONNECT<br />MUSIC TOGETHER</span></div>
    <i className="he-screw top-left" /><i className="he-screw top-right" /><i className="he-screw bottom-left" /><i className="he-screw bottom-right" />
    <svg ref={svg} className={`he-dial ${rotation !== null ? 'dragging' : ''}`} viewBox="0 0 500 500" role="group" aria-label="交互五度圈，拖动或滚轮切换调性" tabIndex={0}
      onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); chooseIndex(selectedIndex + (e.key === 'ArrowRight' ? 1 : -1)) } }}
      onWheel={e => { if (Math.abs(e.deltaY) > 4 && Date.now() - wheelTime.current > 160) { wheelTime.current = Date.now(); chooseIndex(selectedIndex + Math.sign(e.deltaY)) } }}
      onPointerDown={e => { if (e.button !== 0) return; const angle = angleAt(e); suppressClick.current = false; drag.current = { angle, rotation: current, moved: false, last: angle, velocity: 0, time: performance.now() } }}
      onPointerMove={e => {
        const state = drag.current; if (!state) return
        const angle = angleAt(e), delta = mod(angle - state.last + 180, 360) - 180, now = performance.now()
        if (Math.abs(angle - state.angle) > 3) { state.moved = true; e.currentTarget.setPointerCapture(e.pointerId) }
        state.velocity = delta / Math.max(1, now - state.time); state.time = now; state.last = angle; state.rotation += delta
        if (state.moved) setRotation(state.rotation)
      }} onPointerUp={() => finish()} onPointerCancel={() => finish(true)}>
      <defs>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#4b504b" /><stop offset=".18" stopColor="#f9f8eb" /><stop offset=".28" stopColor="#636b63" /><stop offset=".5" stopColor="#252f29" /><stop offset=".68" stopColor="#b5b7aa" /><stop offset=".78" stopColor="#edf0e5" /><stop offset="1" stopColor="#484f47" /></linearGradient>
        <radialGradient id={`${id}-paper`}><stop stopColor="#b5b0a2" /><stop offset=".65" stopColor="#e4e0d6" /><stop offset="1" stopColor="#c7c5ba" /></radialGradient>
        <linearGradient id={`${id}-hub`} x2=".8" y2="1"><stop stopColor="#596a58" /><stop offset="1" stopColor="#1d3027" /></linearGradient>
        <linearGradient id={`${id}-pointer`} x2="1" y2=".2"><stop stopColor="#948773" /><stop offset=".45" stopColor="#f6e8ca" /><stop offset="1" stopColor="#a5987f" /></linearGradient>
      </defs>
      <circle cx="250" cy="250" r="241" fill={`url(#${id}-metal)`} stroke="#827e6e" strokeWidth="2" />
      <circle cx="250" cy="250" r="233" fill="none" stroke="#f2ecdb" strokeWidth="2" />
      <circle cx="250" cy="250" r="224" fill="#35443a" stroke="#a6aa9a" strokeWidth="2" />
      <g className="he-disc" style={{ transform: `rotate(${current}deg)`, transformOrigin: '250px 250px' }}>
        <circle cx="250" cy="250" r="211" fill={`url(#${id}-paper)`} stroke="#7d7c6e" strokeWidth="2" />
        {CIRCLE.map(([major, relative], i) => {
          const pc = mod(parseNote(`${major}4`)!), selected = pc === majorRoot, neighbor = mod(i - selectedIndex, 12) === 1 || mod(i - selectedIndex, 12) === 11
          const [x, y] = point(179, i * 30), [mx, my] = point(127, i * 30)
          return <g key={major}>
            <path d={wedge(151, 210, i * 30)} fill={selected ? '#eef0db' : neighbor ? '#d9ddc9' : 'transparent'} stroke="#8d8b7b" strokeWidth=".65" />
            <path d={wedge(99, 151, i * 30)} fill={selected ? '#bdc6b0' : '#79756513'} stroke="#8d8b7b" strokeWidth=".6" />
            <g role="button" tabIndex={0} aria-label={`${major}大调`} aria-pressed={!minor && root === pc}
              onClick={() => { if (!suppressClick.current) { onMinor(false); onRoot(pc) } }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMinor(false); onRoot(pc) } }}>
              <path d={wedge(151, 210, i * 30)} fill="transparent" />
              <text x={x} y={y + 8} textAnchor="middle" className={activeRoot === pc ? 'he-playing-note' : ''} style={{ transform: `rotate(${-current}deg)`, transformOrigin: `${x}px ${y}px` }}>{major}</text>
            </g>
            <g role="button" tabIndex={0} aria-label={`${relative}小调`} aria-pressed={minor && root === mod(pc + 9)}
              onClick={() => { if (!suppressClick.current) { onMinor(true); onRoot(mod(pc + 9)) } }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMinor(true); onRoot(mod(pc + 9)) } }}>
              <path d={wedge(99, 151, i * 30)} fill="transparent" />
              <text x={mx} y={my + 5} textAnchor="middle" className={`he-minor-label ${activeRoot === mod(pc + 9) ? 'he-playing-note' : ''}`} style={{ transform: `rotate(${-current}deg)`, transformOrigin: `${mx}px ${my}px` }}>{relative}</text>
            </g>
          </g>
        })}
        {Array.from({ length: 60 }, (_, i) => { const a = point(i % 5 ? 217 : 214, i * 6), b = point(222, i * 6); return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#dcd5ba" strokeWidth={i % 5 ? 1 : 2} /> })}
      </g>
      <circle cx="250" cy="250" r="99" fill={`url(#${id}-metal)`} stroke="#2d362d" strokeWidth="2" />
      <circle cx="250" cy="250" r="93" fill={`url(#${id}-hub)`} stroke="#c8c0a7" />
      <circle cx="250" cy="196" r="4" fill={`url(#${id}-pointer)`} />
      <text x="250" y="239" textAnchor="middle" className="he-hub-title">{harmonyRootName(root,minor)} <tspan fontSize="22">{minor ? 'Minor' : 'Major'}</tspan></text>
      <path d="M183 255H317" stroke="#d5d8c8" />
      <text x="250" y="280" textAnchor="middle" className="he-hub-relative">{harmonyRootName(mod(root + (minor ? 3 : 9)),!minor)} {minor ? 'major' : 'minor'}</text>
      <text x="250" y="300" textAnchor="middle" className="he-hub-small">Relative {minor ? 'Major' : 'Minor'}</text>
      <text x="250" y="320" textAnchor="middle" className="he-hub-small">{keySignature(root, minor)}</text>
      <path d="M236 17Q250 10 264 17L255 48Q250 60 245 48Z" fill={`url(#${id}-pointer)`} stroke="#f7efda" strokeWidth="2" className="he-pointer" />
      {[45, 135, 225, 315].map(angle => { const [x,y] = point(231,angle); return <g key={angle}><circle cx={x} cy={y} r="7" fill={`url(#${id}-pointer)`} stroke="#343c33" strokeWidth="2" /><path d={`M${x-3} ${y-3}l6 6m-6 0l6-6`} stroke="#514c40" strokeWidth="1.5" /></g> })}
    </svg>
    <div className="he-dial-caption"><div className="he-tonality"><button className={!minor ? 'active' : ''} onClick={() => onMinor(false)}>Major 大调</button><button className={minor ? 'active' : ''} onClick={() => onMinor(true)}>Minor 小调</button></div><p>拖动转盘 · 滚轮切换 · 点击选调</p><span>{keyName(root, minor)} · {keySignature(root, minor)}</span></div>
    <div className="he-dial-quote">“Music is a higher revelation<br />than all wisdom and philosophy.”<small>— Ludwig van Beethoven</small></div>
  </section>
}
