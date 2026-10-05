import { memo, useMemo } from 'react'
import { MusicXmlScore } from './MusicXmlScore.js'
import { exerciseToMusicXml } from './musicxml.js'
import type { ExerciseConfig, MusicEvent } from './types.js'
import type { Tuning } from './theory.js'
interface Props {
  events: MusicEvent[]
  tuning: Tuning
  config: ExerciseConfig
  onSelect?: (event: MusicEvent) => void
  compact?: boolean
  currentBar?: number
}
export const Score = memo(function Score({ events, tuning, config, onSelect, compact = false, currentBar = 1 }: Props): React.JSX.Element {
  const document = useMemo(() => exerciseToMusicXml(events, tuning, config), [events, tuning, config.meter, config.pattern])
  const rhythm = config.pattern === 'rhythm'
  const legend = [rhythm ? '斜线音头为发音，休止处停止发声' : '第一弦在上 · 数字为品位 · 0 为空弦',
    events.some(e => e.technique === 'mute') ? 'X 闷音' : '',
    events.some(e => e.technique === 'hammer' || e.technique === 'pull') ? 'H/P 击勾弦' : '',
    events.some(e => e.technique === 'slide') ? '斜线滑音' : '',
    events.some(e => e.bend) ? '推弦标记表示升高的音程' : '',
    events.some(e => e.tie) ? '延音线连接的同音不重新起音' : '',
    events.some(e => e.technique === 'up' || e.technique === 'down') ? 'V 为上拨，Π 为下拨' : '',
    onSelect ? '点击音符可试听' : '', '按谱中时值演奏'].filter(Boolean).join(' · ')
  return <section className="ws-score-section">
    {!compact && <div className="ws-panel-heading"><div><small>READ & PLAY</small><h3>
      {rhythm ? '节奏谱' : `${tuning.notes.length} 线 TAB`} <span>{rhythm ? '· 保持大拍，听清起音与休止' : '· 弦品与实际音高同步'}</span>
    </h3></div><span className="ws-tag">{config.subdivision === 3 ? '三等分' : config.subdivision === 4 ? '四等分' : config.subdivision === 2 ? '二等分' : '每拍一音'}</span></div>}
    <MusicXmlScore rolling currentBar={currentBar} xml={document.xml} anchors={document.anchors} className="ws-score" label={rhythm ? '节奏练习谱例' : `${tuning.notes.length} 线练习谱例`}
      onSelect={onSelect ? id => { const event = events.find(e => e.id === id); if (event) onSelect(event) } : undefined} />
    <p className="ws-notation-key">{legend}</p>
  </section>
})
