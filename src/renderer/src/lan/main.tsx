import '../theme-tokens.css'
import { applyAppearance } from '../appearance.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, AudioLines, LoaderCircle, Music2, Pause, Play, RefreshCw, Search, SlidersHorizontal, Wifi, X } from 'lucide-react'
import type { LanSong, LanSongSummary } from '@shared/lan.js'
import { LanPlayer, type MixState } from './player.js'
import './style.css'

const base = new URL('./', location.href)
const systemTheme = matchMedia('(prefers-color-scheme: dark)')
let themeMode = document.documentElement.dataset.themeMode ?? 'warm'
let density = document.documentElement.dataset.density ?? 'normal'
let effects = document.documentElement.dataset.effects ?? 'standard'
const applyLanAppearance = (): void => applyAppearance({ theme: themeMode, density, effects })
applyLanAppearance()
systemTheme.addEventListener('change', () => { if (themeMode === 'system') applyLanAppearance() })
const appearanceEvents = new EventSource(new URL('api/v1/appearance-events', base))
appearanceEvents.onmessage = event => {
  try { const data = JSON.parse(event.data); if (['warm', 'dark', 'system'].includes(data.theme)) { themeMode = data.theme; density = data.density === 'compact' ? 'compact' : 'normal'; effects = data.effects === 'reduced' ? 'reduced' : 'standard'; applyLanAppearance() } } catch { /* Keep the current theme on malformed or interrupted events. */ }
}
window.addEventListener('pagehide', () => appearanceEvents.close(), { once: true })
const time = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
async function get<T>(route: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(route, base), { signal })
  if (!response.ok) throw new Error(response.status === 404 ? '歌曲或访问地址已失效，请重新获取电脑端的局域网地址' : '无法连接电脑端，请检查网络后重试')
  return response.json() as Promise<T>
}

function App(): React.JSX.Element {
  const [songs, setSongs] = useState<LanSongSummary[]>([])
  const [song, setSong] = useState<LanSong | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [pitch, setPitch] = useState(0)
  const [appliedPitch, setAppliedPitch] = useState(0)
  const [mix, setMix] = useState<MixState[]>([])
  const [pointA, setPointA] = useState<number | null>(null)
  const [pointB, setPointB] = useState<number | null>(null)
  const [loop, setLoop] = useState(false)
  const player = useRef<LanPlayer | null>(null)
  const request = useRef<AbortController | null>(null)
  const video = useRef<HTMLVideoElement | null>(null)
  const activeLyric = song?.lyrics?.cues.reduce((active, cue, index) => cue.timeMs <= position * 1000 ? index : active, -1) ?? -1
  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try { setSongs((await get<{ songs: LanSongSummary[] }>('api/v1/songs')).songs) }
    catch (reason) { setError(String((reason as Error).message)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh(); return () => { request.current?.abort(); player.current?.dispose() } }, [refresh])
  useEffect(() => { player.current?.mix(mix) }, [mix])
  useEffect(() => { player.current?.setLoop(loop && pointA !== null && pointB !== null ? { start: pointA, end: pointB } : null) }, [loop, pointA, pointB, busy])
  useEffect(() => {
    document.querySelector('.lyrics .current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeLyric])

  const initialize = (): LanPlayer => {
    if (!player.current) {
      const instance = new LanPlayer()
      instance.onTime = setPosition; instance.onPlaying = setPlaying; instance.onError = setError
      player.current = instance
    }
    player.current.unlock()
    return player.current
  }
  const selectSong = async (summary: LanSongSummary): Promise<void> => {
    request.current?.abort()
    const abort = new AbortController(); request.current = abort
    setBusy(true); setError(''); setSong(null); setPosition(0); setPitch(0); setAppliedPitch(0); setLoop(false); setPointA(null); setPointB(null)
    try {
      const engine = initialize(); engine.clear()
      const detail = await get<LanSong>(summary.manifest, abort.signal)
      if (abort.signal.aborted) return
      setSong(detail)
      const states = detail.stems.filter((stem) => stem.defaultVisible).map(() => ({ gain: 1, muted: false, solo: false }))
      setMix(states)
      await engine.load(detail, base, 0, abort.signal)
      if (abort.signal.aborted) return
      engine.mix(states); engine.attachVideo(video.current)
    } catch (reason) { if (!abort.signal.aborted) setError((reason as Error).message) }
    finally { if (!abort.signal.aborted) setBusy(false) }
  }
  const applyPitch = async (value: number): Promise<void> => {
    if (!song || busy) return
    request.current?.abort()
    const abort = new AbortController(); request.current = abort
    setBusy(true); setError(''); setPitch(value)
    const savedPosition = position
    try {
      const engine = initialize()
      await engine.load(song, base, value, abort.signal)
      if (abort.signal.aborted) return
      engine.attachVideo(video.current); engine.mix(mix); engine.seek(savedPosition)
      setAppliedPitch(value)
    } catch (reason) { if (!abort.signal.aborted) setError((reason as Error).message) }
    finally { if (!abort.signal.aborted) setBusy(false) }
  }
  const back = (): void => {
    request.current?.abort(); player.current?.clear();
    setSong(null); setBusy(false); setPlaying(false); setError(''); void refresh()
  }
  const play = (): void => {
    if (playing) player.current?.pause()
    else { setError(''); void player.current?.play().catch(() => setError('暂时无法播放，请等待音频或视频加载完成后重试')) }
  }
  const updateMix = (index: number, patch: Partial<MixState>): void => setMix((states) => states.map((state, i) => i === index ? { ...state, ...patch } : state))
  const shown = songs.filter((item) => `${item.title} ${item.artist}`.toLowerCase().includes(query.toLowerCase()))
  const visibleStems = song?.stems.filter((stem) => stem.defaultVisible) ?? []

  return <div className="lan-shell"><header className="topbar"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); back() }}><AudioLines size={25} /><b>BandBuddy<span>YOUR PRACTICE COMPANION</span></b></a><span className="connection"><i /><Wifi size={14} />局域网</span></header>
    {error && <div className="error" role="alert">{error}<button onClick={() => song ? void selectSong({ ...song, stemCount: song.stems.length, manifest: `api/v1/songs/${song.id}/manifest` }) : void refresh()}>重试</button></div>}
    {!song ? <main className="library"><div className="eyebrow">MAKE TIME FOR MUSIC</div><h1>今天，练哪一首？</h1><p className="lead">电脑里的分轨音乐，随时在这里练习。</p><div className="library-tools"><label className="search"><Search size={18} /><input aria-label="搜索歌曲" placeholder="搜索歌曲或艺术家" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="icon-button" aria-label="刷新曲库" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={18} /></button></div>
      {loading || busy ? <div className="empty"><LoaderCircle className="spin" />{busy ? '正在准备歌曲…' : '正在读取曲库…'}</div> : shown.length ? <div className="song-grid">{shown.map((item, index) => <button className="song-card" key={item.id} onClick={() => void selectSong(item)}><span className="record"><span><Music2 size={25} /></span></span><span className="song-copy"><small>{String(index + 1).padStart(2, '0')} / {item.stemCount} TRACKS</small><strong>{item.title}</strong><span>{item.artist || '未知艺术家'}</span><em>{time(item.durationMs / 1000)}</em></span><Play className="card-play" size={19} /></button>)}</div> : <div className="empty"><Music2 /><b>{query ? '没有找到匹配歌曲' : '还没有可练习的歌曲'}</b><span>在电脑端导入歌曲，分轨完成后刷新这里。</span></div>}
      <footer>音乐留在你的局域网内。</footer></main> : <main className="practice"><button className="back" onClick={back}><ArrowLeft size={16} />返回曲库</button><div className="practice-heading"><div><div className="eyebrow">PRACTICE ROOM</div><h1>{song.title}</h1><p className="lead">{song.artist || '未知艺术家'} · {visibleStems.length} 条音轨{song.musicalKey ? ` · ${song.musicalKey}` : ''}</p></div>
      <Dialog.Root><Dialog.Trigger className="mix-button"><SlidersHorizontal size={18} />音轨</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="mix-overlay" /><Dialog.Content className="mix-panel" aria-describedby="mix-hint"><header><Dialog.Title>音轨调节</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭音轨调节"><X size={20} /></Dialog.Close></header><Dialog.Description id="mix-hint">M 静音 · S 独奏，所有调节仅影响此设备。</Dialog.Description><div className="mix-tracks">{visibleStems.map((stem, index) => { const state = mix[index]; return state ? <div className="mix-row" key={stem.id}><label htmlFor={`gain-${stem.id}`}><span className="track-dot" />{stem.name}<small>{Math.round(state.gain * 100)}%</small></label><div><input id={`gain-${stem.id}`} type="range" min="0" max="1.5" step="0.01" value={state.gain} onChange={(event) => updateMix(index, { gain: Number(event.target.value) })} /><button aria-label={`${stem.name}静音`} aria-pressed={state.muted} onClick={() => updateMix(index, { muted: !state.muted })}>M</button><button aria-label={`${stem.name}独奏`} aria-pressed={state.solo} onClick={() => updateMix(index, { solo: !state.solo })}>S</button></div></div> : null })}</div><button className="reset" onClick={() => setMix(visibleStems.map(() => ({ gain: 1, muted: false, solo: false })))}>重置所有音轨</button></Dialog.Content></Dialog.Portal></Dialog.Root></div>
      <div className={`practice-stage ${song.video ? 'with-video' : ''}`}>{song.video ? <video ref={(element) => { video.current = element; player.current?.attachVideo(element) }} src={new URL(`${song.video.url}?web=1`, base).href} muted playsInline preload="auto" onError={() => setError('视频加载失败，请在电脑端检查视频文件后重试')} /> : !song.lyrics?.cues.length ? <div className={`large-record ${playing ? 'playing' : ''}`}><span><AudioLines size={40} /><small>BANDBUDDY</small></span></div> : null}
      {song.lyrics?.cues.length ? <div className="lyrics" aria-label="歌词">{song.lyrics.cues.map((cue, index) => <button disabled={busy} key={`${cue.timeMs}-${index}`} className={index === activeLyric ? 'current' : ''} onClick={() => player.current?.seek(cue.timeMs / 1000)}>{cue.lines.join('\n')}</button>)}</div> : <p className="stage-caption">{song.video ? '视频与音轨同步播放' : '找到自己的节奏，慢慢来。'}</p>}</div>
      <section className="transport" aria-label="播放控制"><div className="timeline"><input aria-label="播放进度" disabled={busy} type="range" min="0" max={song.durationMs / 1000} step="0.01" value={position} onChange={(event) => player.current?.seek(Number(event.target.value))} /><div><span>{time(position)}</span><span>{time(song.durationMs / 1000)}</span></div></div><div className="controls"><div className="ab-controls"><button disabled={busy} onClick={() => { setPointA(position); if (pointB !== null && pointB <= position) { setPointB(null); setLoop(false) } }}>A <small>{pointA === null ? '起点' : time(pointA)}</small></button><button disabled={busy || pointA === null || position <= pointA + 0.1} onClick={() => { setPointB(position); setLoop(true) }}>B <small>{pointB === null ? '终点' : time(pointB)}</small></button><button aria-label="AB循环" aria-pressed={loop} disabled={pointA === null || pointB === null || busy} onClick={() => setLoop(!loop)}>循环</button><button aria-label="清除AB段" disabled={pointA === null && pointB === null} onClick={() => { setPointA(null); setPointB(null); setLoop(false) }}><X size={14} /></button></div><button className="play-button" aria-label={playing ? '暂停' : '播放'} disabled={busy || Boolean(error)} onClick={play}>{busy ? <LoaderCircle className="spin" /> : playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><div className="pitch-controls"><span>升降调</span><button aria-label="降半音" disabled={busy || pitch <= -12} onClick={() => void applyPitch(pitch - 1)}>−</button><button className="pitch-value" title="恢复原调" disabled={busy} onClick={() => void applyPitch(0)}>{pitch > 0 ? '+' : ''}{pitch}</button><button aria-label="升半音" disabled={busy || pitch >= 12} onClick={() => void applyPitch(pitch + 1)}>+</button></div></div><p className="transport-note" role="status">{busy ? (pitch !== appliedPitch ? '电脑正在准备升降调音轨，首次处理需要一点时间…' : '正在加载音轨，请稍候…') : '点击歌词可跳转 · A / B 标记练习范围 · 点击音调数值恢复原调'}</p></section></main>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
