import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ScoreProject } from '@shared/scores.js'
import { MusicXmlScore } from '../woodshed/MusicXmlScore.js'
import type { ScoreAnchor } from '../woodshed/musicxml.js'

export function ScoreNotation({ project, trackIds, tab, bar, position, onSeek }: { project: ScoreProject; trackIds: string[]; tab: boolean; bar: number; position: number; onSeek(time: number): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const result = useQuery({ queryKey: ['score-notation', project.id, project.activeRun, trackIds.join(','), tab, bar], queryFn: () => window.bandbuddy.scores.notation(project.id, trackIds, tab, bar), staleTime: Infinity, retry: false, networkMode: 'always' })
  const noteMap = useMemo(() => new Map(project.data?.tracks.flatMap(t => t.notes.map(n => [n.id, n] as const))), [project.data])
  const anchors = useMemo((): ScoreAnchor[] => {
    if (!result.data) return []
    const doc = new DOMParser().parseFromString(result.data.xml, 'application/xml'), values: ScoreAnchor[] = []
    let staffBase = 0
    for (const part of doc.querySelectorAll('part')) {
      const count = Number(part.querySelector('staves')?.textContent ?? 1)
      for (const note of part.querySelectorAll('note[id]')) {
        const match = /^n(.*)-(\d+)-(\d+)$/.exec(note.id)
        if (!match || !noteMap.has(match[1]!)) continue
        values.push({ id: match[1]!, staff: staffBase + Number(match[2]), voice: Number(note.querySelector('voice')?.textContent ?? 1), beat: Number(match[3]) / 480 - result.data.startBeat, label: `定位音符 ${noteMap.get(match[1]!)!.pitch}` })
      }
      staffBase += count
    }
    return values
  }, [result.data, noteMap])
  useEffect(() => {
    for (const element of host.current?.querySelectorAll('[data-event]') ?? []) {
      const note = noteMap.get(element.getAttribute('data-event')!)
      element.classList.toggle('active', Boolean(note && note.start <= position && note.end > position))
    }
  }, [position, noteMap, result.data])
  if (result.isPending) return <div className="score-placeholder" role="status">正在排版第 {bar + 1}–{bar + 8} 小节…</div>
  if (result.error) return <div className="score-placeholder" role="alert"><p>{String(result.error.message)}</p><button className="outline-button" onClick={() => void result.refetch()}>重新生成此页</button></div>
  return <div ref={host} className="score-notation"><MusicXmlScore xml={result.data.xml} label={tab ? '吉他与贝斯指法谱' : '分轨五线谱'} anchors={anchors} onSelect={id => { const n = noteMap.get(id); if (n) onSeek(n.start) }} /></div>
}
