import { memo } from 'react'
import type { EnsembleScore } from './ensemble-material.js'
const black = (midi: number): boolean => [1, 3, 6, 8, 10].includes(midi % 12)
const name = (midi: number): string => `${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi % 12]}${Math.floor(midi / 12) - 1}`
export const EnsembleKeyboard = memo(function EnsembleKeyboard({ score }: { score: EnsembleScore }): React.JSX.Element {
 const pitches = score.events.flatMap(e => e.notes)
 if (!pitches.length) return <></>
 const low = Math.floor(Math.min(...pitches) / 12) * 12, high = Math.ceil((Math.max(...pitches) + 1) / 12) * 12 - 1
 const notes = Array.from({ length: high - low + 1 }, (_, i) => low + i)
 const whites = notes.filter(n => !black(n)), width = whites.length * 35
 return <figure className="ensemble-keyboard"><div><svg viewBox={`0 0 ${width} 135`} style={{ minWidth: width }} role="img" aria-label="练习键盘，按实际音高显示">
  {whites.map((n,i) => <g key={n}><rect data-ensemble-midi={n} x={i * 35} y="0" width="34" height="125" rx="3" fill={pitches.includes(n) ? '#e3ecdc' : '#fffdf7'} stroke="#c8beaa" /><text x={i * 35 + 17} y="112" textAnchor="middle" fontSize="10">{name(n)}</text></g>)}
  {notes.filter(black).map(n => { const x = whites.filter(w => w < n).length * 35 - 11; return <g key={n}><rect data-ensemble-midi={n} x={x} y="0" width="22" height="75" rx="3" fill={pitches.includes(n) ? '#577562' : '#393d37'} /><text x={x + 11} y="65" textAnchor="middle" fontSize="8" fill="white">{name(n)}</text></g> })}
 </svg></div><figcaption>浅绿为本练习使用的白键，深绿黑键为使用的升降音；播放时高亮当前声部，左、右手以谱面为准。</figcaption></figure>
})
