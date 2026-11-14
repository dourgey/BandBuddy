import { DEFAULT_SCORE_SETTINGS, scorePlaybackMidi, type ScoreApi, type ScoreData, type ScoreProject, type ScoreRuntime } from '@shared/scores.js'
import fixture from './fixture-data.json'

/** Only loaded by the existing ?fixtures development bridge; never used for inference. */
export function createScoreFixtureApi(): ScoreApi {
  const changed = new Set<() => void>(), notify = (): void => changed.forEach(fn => fn())
  const data = fixture.data as ScoreData
  const project: ScoreProject = {
    id: '4df61de4-4635-42cc-b0db-332095e34ab4', title: '夜航 · 原创练习（演示）', sourceSongId: null,
    sources: [{ id: 'fixture-source', name: '原创练习', file: '', hash: '', duration: data.duration }],
    model: 'small', device: 'cpu', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', openedAt: null,
    activeRun: 'demo', settings: DEFAULT_SCORE_SETTINGS, practice: { rate: 1, position: 0, loop: null, tracks: {} },
    data, jobId: null, status: 'completed', progress: 1, phase: '演示谱 · 合成音符，非模型转谱结果', error: null
  }
  let projects = [project]
  const runtime: ScoreRuntime = { ready: true, busy: false, stage: '浏览器演示环境', progress: 1, device: 'cpu', models: { small: true, medium: false, large: false }, soundfont: true, accepted: true, hasToken: false, error: null }
  return {
    list: async () => structuredClone(projects.map(p => ({ ...p, data: null }))),
    get: async id => structuredClone(projects.find(p => p.id === id) ?? null),
    create: async input => { const p = { ...structuredClone(project), id: crypto.randomUUID(), title: input.title ?? '导入练习（演示）', sourceSongId: input.songId ?? null }; projects.unshift(p); notify(); return p },
    transcribe: async () => { throw new Error('浏览器预览仅提供演示乐谱，真实转谱请在桌面应用使用。') },
    render: async (id, settings) => { const p = projects.find(p => p.id === id)!; p.settings = settings; p.activeRun = crypto.randomUUID(); notify(); return p.activeRun },
    savePractice: async (id, practice) => { const p = projects.find(p => p.id === id); if (p) p.practice = structuredClone(practice) },
    notation: async (_id, ids, tab, startBar) => {
      const page = fixture.pages[Math.min(1, Math.floor(startBar / 8))]!
      const doc = new DOMParser().parseFromString(tab ? page.tab : page.staff, 'application/xml')
      for (const [i, track] of data.tracks.entries()) if (ids.length && !ids.includes(track.id)) {
        doc.querySelector(`part[id="P${i + 1}"]`)?.remove(); doc.querySelector(`score-part[id="P${i + 1}"]`)?.remove()
      }
      return { xml: new XMLSerializer().serializeToString(doc), startBeat: page.startBeat, bars: 16 }
    },
    export: async (_id, ids, format, _quantized, tab) => {
      const selected = { ...data, tracks: data.tracks.filter(t => !ids.length || ids.includes(t.id)) }
      const bytes = format === 'midi' ? scorePlaybackMidi(selected).bytes : new TextEncoder().encode(tab ? fixture.pages[0]!.tab : fixture.pages[0]!.staff)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: format === 'midi' ? 'audio/midi' : 'application/xml' }))
      const a = document.createElement('a'); a.href = url; a.download = `demo.${format === 'midi' ? 'mid' : 'musicxml'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); return a.download
    },
    delete: async id => { projects = projects.filter(p => p.id !== id); notify() },
    runtime: async () => ({ ...runtime }), prepare: async () => runtime, cancelPreparation: async () => {},
    soundfont: async () => { const r = await fetch('/score-fixture.sf3'); if (!r.ok) throw new Error('浏览器演示需要测试音色资源；桌面应用从转谱组件加载本地音色。'); return new Uint8Array(await r.arrayBuffer()) },
    onChanged: callback => { changed.add(callback); return () => { changed.delete(callback) } }
  }
}
