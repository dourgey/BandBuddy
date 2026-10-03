import { memo, useMemo } from 'react'
import { DRUM_LABELS, type EnsembleScore as ScoreData } from './ensemble-material.js'
import { MusicXmlScore } from './MusicXmlScore.js'
import { ensembleToMusicXml } from './musicxml.js'

export const EnsembleScore = memo(function EnsembleScore({ score, drums }: { score: ScoreData; drums: boolean }): React.JSX.Element {
  const document = useMemo(() => ensembleToMusicXml(score, drums), [score, drums])
  const voices = [...new Set(score.events.flatMap(e => e.drum ? [e.drum] : []))]
  return <div className="ensemble-score" aria-label={drums ? '鼓组五线谱' : '钢琴大谱表'}>
    <MusicXmlScore xml={document.xml} anchors={document.anchors} eventAttribute="data-ensemble-event" label={score.name} />
    <p className="ws-notation-key">{drums
      ? `鼓件：${voices.map(d => DRUM_LABELS[d]).join('、')}。叉形音头为镲片；括号为轻击，> 为重音，○ 为开镲；R 右手、L 左手，符干向下为脚部声部。`
      : '上方高音谱表为右手，下方低音谱表为左手；两手按同一小节线对齐。弧线连接的同音持续保持，休止处释放。'}</p>
  </div>
})
