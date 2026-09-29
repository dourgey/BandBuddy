import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, Square } from 'lucide-react'
import { DRUM_LANES, DRUM_PRESETS, DRUM_STEPS, defaultDrumDraft, toggleDrumStep, type DrumDraft, type DrumPresetId } from './drum-patterns.js'
import type { WoodshedAudio } from './audio.js'
import type { Preferences } from './types.js'

type MachineState = Preferences['drumMachine']
interface SampleInfo { midiNote: number; file: string; nameZh: string }

function sampleBaseUrl(): string {
  return window.location.protocol === 'file:'
    ? 'bandbuddy-media://drum/'
    : new URL('woodshed/drums/', document.baseURI).href
}

export function DrumMachine({
  machine, update, audio, onError
}: {
  machine: MachineState
  update: (change: (current: MachineState) => MachineState) => void
  audio: WoodshedAudio | null
  onError: (message: string) => void
}): React.JSX.Element {
  const selected = machine.selectedPresetId
  const draft = machine.drafts[selected] ?? defaultDrumDraft(selected)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [step, setStep] = useState(-1)
  const token = useRef(0)
  const resumeStep = useRef(0)
  const baseUrl = sampleBaseUrl()

  useEffect(() => {
    const controller = new AbortController()
    void fetch(new URL('manifest.json', baseUrl), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('无法读取鼓采样清单')
        return response.json() as Promise<{ samples: SampleInfo[] }>
      })
      .then((manifest) => setSamples(manifest.samples))
      .catch((error) => { if (!controller.signal.aborted) onError(String(error)) })
    return () => controller.abort()
  }, [baseUrl, onError])

  useEffect(() => () => {
    token.current++
    audio?.stop()
  }, [audio])

  const changeDraft = (change: (current: DrumDraft) => DrumDraft): void => {
    update((current) => {
      const id = current.selectedPresetId
      return { ...current, drafts: { ...current.drafts, [id]: change(current.drafts[id] ?? defaultDrumDraft(id)) } }
    })
  }
  const stop = (): void => {
    token.current++
    resumeStep.current = 0
    audio?.stop()
    setPlaying(false)
    setStep(-1)
    setLoading(false)
  }
  const pause = (): void => {
    token.current++
    audio?.stop()
    setPlaying(false)
    setStep(-1)
    setLoading(false)
  }
  const start = async (): Promise<void> => {
    if (!audio || !samples.length || loading) return
    const ticket = ++token.current
    setLoading(true)
    try {
      const buffers = await audio.loadDrumSamples(samples, baseUrl)
      if (ticket !== token.current) return
      await audio.playDrums(() => draftRef.current, buffers, (next) => {
        setStep(next)
        if (next >= 0) resumeStep.current = (next + 1) % DRUM_STEPS
        if (next < 0) setPlaying(false)
      }, resumeStep.current)
      if (ticket === token.current) setPlaying(true)
    } catch (error) {
      if (ticket === token.current) onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (ticket === token.current) setLoading(false)
    }
  }

  return (
    <section className="ws-tool-panel ws-drum-machine">
      <div className="ws-panel-heading">
        <div><small>BUILD A GROOVE</small><h2>鼓机</h2></div>
        <span className="ws-tag">16 步 · 4/4 · 循环</span>
      </div>
      <div className="ws-drum-controls">
        <label>节奏预设
          <select aria-label="鼓机节奏预设" value={selected} onChange={(event) => {
            stop()
            update((current) => ({ ...current, selectedPresetId: event.target.value as DrumPresetId }))
          }}>
            {DRUM_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        <label>速度 BPM
          <input aria-label="鼓机速度 BPM" type="number" min="40" max="240" value={draft.bpm} onChange={(event) => {
            stop()
            changeDraft((current) => ({ ...current, bpm: Math.max(40, Math.min(240, Math.round(Number(event.target.value)) || 40)) }))
          }} />
        </label>
        <label>Swing {Math.round(draft.swing * 100)}%
          <input aria-label="鼓机 Swing" type="range" min="50" max="75" value={Math.round(draft.swing * 100)} onChange={(event) => {
            stop()
            changeDraft((current) => ({ ...current, swing: Number(event.target.value) / 100 }))
          }} />
        </label>
        <label>音量 {Math.round(draft.volume * 100)}%
          <input aria-label="鼓机音量" type="range" min="0" max="100" value={Math.round(draft.volume * 100)} onChange={(event) => changeDraft((current) => ({ ...current, volume: Number(event.target.value) / 100 }))} />
        </label>
      </div>
      <div className="ws-drum-transport">
        <button className="ws-button primary" disabled={!audio || !samples.length || loading} onClick={() => playing ? pause() : void start()}>
          {playing ? <Pause size={16} /> : <Play size={16} />}{loading ? '正在载入音色…' : playing ? '暂停' : '播放'}
        </button>
        <button className="ws-button" onClick={stop}><Square size={14} />停止</button>
        <button className="ws-button" onClick={() => {
          stop()
          update((current) => {
            const drafts = { ...current.drafts }
            delete drafts[current.selectedPresetId]
            return { ...current, drafts }
          })
        }}><RotateCcw size={14} />恢复当前预设</button>
        <small>{samples.length ? `${samples.length} 种鼓采样已就绪` : '正在读取鼓采样…'} · 修改自动保存到本机</small>
      </div>
      <div className="ws-drum-grid-scroll">
        <div className="ws-drum-grid" role="group" aria-label="鼓机十六步音序器">
          <div className="ws-drum-grid-head"><span>鼓轨</span>{Array.from({ length: DRUM_STEPS }, (_, i) => <b key={i} className={step === i ? 'current' : ''}>{i + 1}</b>)}<span>音色</span></div>
          {DRUM_LANES.map((lane) => (
            <div className="ws-drum-row" key={lane.id}>
              <span>{lane.name}</span>
              {Array.from({ length: DRUM_STEPS }, (_, i) => (
                <button
                  key={i}
                  aria-label={`${lane.name} 第 ${i + 1} 步`}
                  aria-pressed={Boolean(draft.steps[lane.id] & (1 << i))}
                  className={step === i ? 'current' : ''}
                  onClick={() => changeDraft((current) => ({ ...current, steps: toggleDrumStep(current.steps, lane.id, i) }))}
                />
              ))}
              <select aria-label={`${lane.name}音色`} value={draft.sounds[lane.id]} onChange={(event) => changeDraft((current) => ({ ...current, sounds: { ...current.sounds, [lane.id]: Number(event.target.value) } }))}>
                {samples.map((sample) => <option key={sample.midiNote} value={sample.midiNote}>{sample.nameZh}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
      <p className="ws-muted">每格为十六分音符；开镲和闭镲在同一格互斥。选取新预设后可保留各自的编辑，点击“恢复当前预设”还原该节奏。</p>
    </section>
  )
}
