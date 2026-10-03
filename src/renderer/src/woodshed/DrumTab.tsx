import { useMemo } from 'react'
import type { MusicXmlScoreProps } from './MusicXmlScore.js'

const names: Record<number, string> = { 35: '底鼓', 36: '底鼓', 37: '边击', 38: '军鼓', 40: '军鼓', 41: '低嗵', 42: '闭镲', 43: '低嗵', 44: '踩镲', 45: '中嗵', 46: '开镲', 47: '中嗵', 48: '高嗵', 49: '强音镲', 50: '高嗵', 51: '叮叮镲', 52: '中国镲', 53: '镲帽', 55: '水镲', 57: '强音镲', 59: '叮叮镲' }
export function readDrumTab(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const labels = new Map<string, string>()
  for (const inst of doc.querySelectorAll('score-instrument')) {
    const id = inst.getAttribute('id')!
    const midi = [...doc.querySelectorAll('midi-instrument')].find(m => m.getAttribute('id') === id)
    labels.set(id, names[Number(midi?.querySelector('midi-unpitched')?.textContent) - 1] || inst.querySelector('instrument-name')?.textContent || '鼓件')
  }
  let divisions = 1, beats = 4, unit = 1, absolute = 0
  return [...doc.querySelectorAll('part > measure')].map(measure => {
    divisions = Number(measure.querySelector('divisions')?.textContent || divisions)
    const time = measure.querySelector('time')
    if (time) { beats = (time.querySelector('beats')?.textContent || '4').split('+').reduce((a, b) => a + Number(b), 0); unit = 4 / Number(time.querySelector('beat-type')?.textContent || 4) }
    let cursor = 0, last = 0, end = 0
    const hits: { beat: number; absolute: number; voice: number; instrument: string; label: string; symbol: string; hand: string }[] = []
    for (const node of measure.children) {
      const duration = Number(node.querySelector('duration')?.textContent || 0) / divisions
      if (node.tagName === 'backup') cursor -= duration
      if (node.tagName === 'forward') cursor += duration
      if (node.tagName !== 'note') continue
      const beat = node.querySelector('chord') ? last : cursor
      if (!node.querySelector('rest')) {
        const instrument = node.querySelector('instrument')?.getAttribute('id') || 'percussion'
        const label = labels.get(instrument) || '节奏'
        const ghost = node.querySelector('notehead')?.getAttribute('parentheses') === 'yes'
        const symbol = node.querySelector('open-string') || label === '开镲' ? '○' : node.querySelector('notehead')?.textContent === 'x' ? '×' : '●'
        hits.push({ beat, absolute: absolute + beat, voice: Number(node.querySelector('voice')?.textContent || 1), instrument, label,
          symbol: `${node.querySelector('accent') ? '>' : ''}${ghost ? `(${symbol})` : symbol}`, hand: node.querySelector('lyric text')?.textContent || '' })
      }
      if (!node.querySelector('chord')) { last = cursor; cursor += duration }
      end = Math.max(end, cursor)
    }
    const length = measure.getAttribute('implicit') === 'yes' ? end : Math.max(end, beats * unit)
    absolute += length
    return { number: measure.getAttribute('number'), length, beats, unit, hits }
  })
}

export function DrumTab({ xml, label, anchors, eventAttribute = 'data-event', onSelect }: MusicXmlScoreProps): React.JSX.Element {
  const measures = useMemo(() => readDrumTab(xml), [xml])
  const rows = [...new Map(measures.flatMap(m => m.hits.map(h => [h.instrument, h.label] as const)))]
  return <div className="ws-drum-tab" aria-label={`${label} · 鼓组 TAB`}>
    <p className="ws-notation-key">鼓组 TAB · 同一竖列同时击打 · 空位休止 · 括号轻击 · &gt; 重音 · ○ 开镲 · R/L 手序</p>
    <div className="ws-drum-tab-measures">{measures.map((measure, index) => <section key={index} className="ws-drum-tab-bar" style={{ minWidth: Math.max(300, measure.length * 110) }} aria-label={`第 ${measure.number} 小节`}>
      <div className="ws-drum-tab-row"><b>小节 {measure.number}</b><div className="ws-drum-tab-track">{Array.from({ length: measure.beats }, (_, beat) => <small key={beat} style={{ left: `${beat * measure.unit / measure.length * 100}%` }}>{beat + 1}</small>)}</div></div>
      {rows.map(([id, name]) => <div className="ws-drum-tab-row" key={id}><b>{name}</b><div className="ws-drum-tab-track">
        {Array.from({ length: measure.beats }, (_, beat) => <i key={beat} style={{ left: `${beat * measure.unit / measure.length * 100}%` }} />)}
        {measure.hits.filter(h => h.instrument === id).map((hit, i) => {
          const anchor = anchors?.find(a => Math.abs(a.beat - hit.absolute) < .001 && a.voice === hit.voice && (!a.instrument || a.instrument === hit.instrument))
          const attributes = anchor ? { [eventAttribute]: anchor.id } : {}
          return <button type="button" key={i} {...attributes} className="ws-drum-tab-hit" style={{ left: `${hit.beat / measure.length * 100}%` }} aria-label={`${name}，第 ${Number((hit.beat / measure.unit + 1).toFixed(3))} 拍${hit.hand ? `，${hit.hand}` : ''}`} onClick={anchor && onSelect ? () => onSelect(anchor.id) : undefined} tabIndex={anchor && onSelect ? 0 : -1}>
            {hit.symbol}<small>{hit.hand}</small>
          </button>
        })}
      </div></div>)}
    </section>)}</div>
  </div>
}
