import { memo, useId } from 'react'
import { noteName } from './theory.js'

type Reading = { midi: number; cents: number; hz: number } | null

// Reference geometry: a circular upper arch with a short, flat-bottomed readout bay.
const outline = 'M 18 492 A 482 482 0 0 1 982 492 L 974 592 Q 971 632 935 632 H 65 Q 29 632 26 592 Z'
const ticks = Array.from({ length: 33 }, (_, index) => {
  const angle = Math.PI * (1 - index / 32)
  const major = index % 8 === 0
  const length = major ? 54 : index % 4 === 0 ? 33 : 20
  const point = (r: number) => ({ x: 500 + r * Math.cos(angle), y: 490 - r * Math.sin(angle) })
  const radius = major ? 420 : 403
  return { outer: point(radius), inner: point(radius - length), major, zero: index === 16 }
})

const GaugeFace = memo(function GaugeFace({ id }: { id: string }): React.JSX.Element {
  return <>
    <defs>
      <linearGradient id={`${id}-rim`} x1="0" y1="0" x2=".7" y2="1">
        <stop stopColor="#c9c5b9" /><stop offset=".16" stopColor="#5b5c55" />
        <stop offset=".48" stopColor="#282d29" /><stop offset=".75" stopColor="#73746b" /><stop offset="1" stopColor="#eeece3" />
      </linearGradient>
      <radialGradient id={`${id}-face`} cx="48%" cy="63%" r="65%">
        <stop stopColor="#faf7ee" /><stop offset=".65" stopColor="#f0ebdf" /><stop offset=".9" stopColor="#dfd8c9" /><stop offset="1" stopColor="#b6b0a3" />
      </radialGradient>
      <linearGradient id={`${id}-needle`}><stop stopColor="#233b2c" /><stop offset=".35" stopColor="#61745d" /><stop offset=".6" stopColor="#344b37" /><stop offset="1" stopColor="#172c20" /></linearGradient>
      <filter id={`${id}-shadow`} x="-100%" y="-30%" width="300%" height="170%"><feDropShadow dx="4" dy="7" stdDeviation="4" floodColor="#28261d" floodOpacity=".32" /></filter>
      <clipPath id={`${id}-glass`}><path d={outline} transform="translate(500 320) scale(.969 .963) translate(-500 -320)" /></clipPath>
      <filter id={`${id}-recess`} x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="blur" />
        <feComposite in="SourceAlpha" in2="blur" operator="out" result="edge" />
        <feFlood floodColor="#534c3b" floodOpacity=".28" />
        <feComposite in2="edge" operator="in" />
        <feComposite in2="SourceGraphic" operator="over" />
      </filter>
      <filter id={`${id}-grain`}><feTurbulence type="fractalNoise" baseFrequency=".82" numOctaves="3" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
    </defs>
    <path d={outline} fill={`url(#${id}-rim)`} stroke="#aaa79c" strokeWidth="20" />
    <path d={outline} fill="none" stroke="#343a32" strokeWidth="7" />
    <path d={outline} transform="translate(500 320) scale(.991 .989) translate(-500 -320)" fill="none" stroke="#dedbce" strokeOpacity=".6" strokeWidth="2" />
    <path d={outline} transform="translate(500 320) scale(.972 .965) translate(-500 -320)" fill={`url(#${id}-face)`} stroke="#d6d2c6" strokeWidth="3" filter={`url(#${id}-recess)`} />
    <path d={outline} transform="translate(500 320) scale(.981 .974) translate(-500 -320)" fill="none" stroke="#f7f5ec" strokeWidth="3" />
    <path d={outline} transform="translate(500 320) scale(.957 .941) translate(-500 -320)" fill="none" stroke="#a5a297" strokeOpacity=".24" strokeWidth="5" />
    <g clipPath={`url(#${id}-glass)`}>
      <rect width="1000" height="650" filter={`url(#${id}-grain)`} opacity=".12" />
      <path d="M 80 490 A 420 420 0 0 1 920 490" fill="none" stroke="#b9b19f" strokeOpacity=".55" strokeWidth="16" />
      <path d="M 390 85 A 420 420 0 0 1 610 85" fill="none" stroke="#9ab591" strokeWidth="17" />
      {ticks.map(({ outer, inner, major, zero }, i) => <line key={i} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke={zero ? '#365d3d' : '#474a42'} strokeWidth={zero ? 6 : major ? 3 : i % 4 === 0 ? 2.7 : 1.25} strokeLinecap="round" />)}
      <g className="ws-analog-scale">
        <text x="78" y="527" textAnchor="middle">−50</text><text x="184" y="185" textAnchor="middle">−25</text>
        <text x="500" y="53" textAnchor="middle">0</text>
        <text x="816" y="185" textAnchor="middle">+25</text><text x="922" y="527" textAnchor="middle">+50</text>
      </g>
    </g>
  </>
})

// Keep the static optical layer independent of live microphone readings.
const GaugeGlass = memo(function GaugeGlass({ id }: { id: string }): React.JSX.Element {
  return <svg className="ws-analog-glass" viewBox="0 0 1000 650" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-softbox`} x1="0" y1="0" x2=".85" y2="1">
        <stop stopColor="#fff" stopOpacity=".48" />
        <stop offset=".35" stopColor="#fff" stopOpacity=".24" />
        <stop offset=".72" stopColor="#f5faf7" stopOpacity=".065" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`${id}-rim-light`} x1="0" y1="0" x2=".85" y2="1">
        <stop stopColor="#fff" stopOpacity=".92" />
        <stop offset=".4" stopColor="#fff" stopOpacity=".12" />
        <stop offset=".68" stopColor="#dae6df" stopOpacity=".05" />
        <stop offset="1" stopColor="#fff" stopOpacity=".8" />
      </linearGradient>
      <radialGradient id={`${id}-glass-bloom`} cx=".28" cy=".12" r=".74">
        <stop stopColor="#fff" stopOpacity=".24" /><stop offset=".6" stopColor="#fff" stopOpacity=".035" /><stop offset="1" stopColor="#cbdcd5" stopOpacity=".055" />
      </radialGradient>
      <filter id={`${id}-soft-light`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5" /></filter>
    </defs>
    <g clipPath={`url(#${id}-glass)`}>
      <path d={outline} fill={`url(#${id}-glass-bloom)`} />
      <path d="M 130 0 H 418 L 140 650 H -90 Z" fill={`url(#${id}-softbox)`} filter={`url(#${id}-soft-light)`} />
      <path d="M 433 2 H 465 L 194 640 H 176 Z" fill={`url(#${id}-softbox)`} opacity=".44" />
      <path d="M 623 14 L 653 24 L 430 645 H 411 Z" fill="white" opacity=".07" />
      <path d="M 86 395 A 451 451 0 0 1 854 180" fill="none" stroke="white" strokeWidth="15" opacity=".23" filter={`url(#${id}-soft-light)`} />
      <path d="M 634 34 Q 848 112 932 316" fill="none" stroke="white" strokeWidth="20" opacity=".27" />
      <path d="M 635 36 Q 853 126 927 315" fill="none" stroke="white" strokeWidth="3" opacity=".82" />
      <path d={outline} transform="translate(500 320) scale(.959 .948) translate(-500 -320)" fill="none" stroke={`url(#${id}-rim-light)`} strokeWidth="5" />
      <path d="M 43 560 Q 45 620 79 620 H 923 Q 955 620 957 568" fill="none" stroke="white" strokeWidth="11" opacity=".3" filter={`url(#${id}-soft-light)`} />
      <path d="M 45 578 Q 47 620 77 620 H 924 Q 951 620 955 580" fill="none" stroke="white" strokeWidth="4" opacity=".74" />
      <path d="M 56 595 Q 64 611 84 612 H 309" fill="none" stroke="#fff" strokeWidth="2" opacity=".85" />
    </g>
  </svg>
})

export function AnalogTunerGauge({ reading }: { reading: Reading }): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const cents = Math.max(-50, Math.min(50, reading?.cents ?? 0))
  const theta = Math.PI * (.5 - cents / 100)
  // Aim at the printed circular scale from the raised mechanical pivot.
  const dx = 402 * Math.cos(theta)
  const dy = 490 - 402 * Math.sin(theta) - 370
  const angle = Math.atan2(dx, -dy) * 180 / Math.PI
  const length = Math.hypot(dx, dy)
  const rounded = Math.round(reading?.cents ?? 0)
  const accurate = reading !== null && Math.abs(reading.cents) <= 3
  return <div className={`ws-analog-gauge ${reading ? 'has-reading' : ''}`}>
    <svg className="ws-analog-svg" viewBox="0 0 1000 650" role="img" aria-label={reading ? `音准 ${reading.cents.toFixed(1)} 音分` : '音准表无有效读数'}>
      <GaugeFace id={id} />
      <g clipPath={`url(#${id}-glass)`}>
        <g className="ws-analog-needle" style={{ transform: `translate(500px, 370px) rotate(${angle}deg) scaleY(${length / 282})` }}>
          <path d="M -7 10 L -3 -278 Q 0 -287 3 -278 L 7 10 Z" fill={`url(#${id}-needle)`} stroke="#213827" strokeWidth="1" filter={`url(#${id}-shadow)`} />
          <path d="M -3 0 L -1.4 -276" fill="none" stroke="#d5ddc8" strokeOpacity=".55" strokeWidth="1" />
        </g>
        <text className="ws-analog-note" x="500" y="488" textAnchor="middle">{reading ? noteName(reading.midi) : '—'}</text>
        <text className="ws-analog-frequency" x="500" y="525" textAnchor="middle">{reading ? `${reading.hz.toFixed(2)} Hz` : '等待音高'}</text>
        <text className="ws-analog-cents" x="500" y="571" textAnchor="middle">{reading ? `${rounded > 0 ? '+' : ''}${rounded} ¢` : '— ¢'}</text>
        <rect x="439" y="578" width="122" height="37" rx="18.5" fill={accurate ? '#c7d4be' : '#d9dace'} fillOpacity=".74" />
        <text className="ws-analog-verdict" x="500" y="604" textAnchor="middle">{reading ? accurate ? '准确' : reading.cents < 0 ? '稍低' : '稍高' : '等待拨弦'}</text>
      </g>
    </svg>
    <div className="ws-analog-pivot" aria-hidden="true" />
    <GaugeGlass id={id} />
  </div>
}
