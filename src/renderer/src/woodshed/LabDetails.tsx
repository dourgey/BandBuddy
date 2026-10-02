import { ChartNoAxesColumnIncreasing, Eraser, Guitar, Play, Square, Volume2 } from 'lucide-react'
import { frequency, materialNotes, mod, noteName, ROOTS, type Material, type Position } from './theory.js'
import {
  CHORDS,
  SCALES,
  degreeFor,
  intervalNames,
  prettyDegree,
  type LabModule,
  type PositionSystem
} from './lab-model.js'
import type { LabSettings } from './lab-settings.js'
import { LabSelect } from './LabControls.js'

export type LabOverlay = 'scale' | 'chord' | 'interval' | 'none'
export const LAB_NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
export function LabDetails({
  settings,
  module,
  system,
  material,
  selected,
  a4,
  overlay,
  filter,
  single,
  direction,
  playing,
  onRoot,
  onContent,
  onOverlay,
  onSingle,
  onDirection,
  onPlay,
  onPreview
}: {
  settings: LabSettings
  module: LabModule
  system: PositionSystem
  material: Material
  selected: Position | null
  a4: number
  overlay: LabOverlay
  filter: 'all' | 'natural' | 'single'
  single: number
  direction: string
  playing: boolean
  onRoot(root: number): void
  onContent(value: string, chord: boolean): void
  onOverlay(value: LabOverlay): void
  onSingle(note: number): void
  onDirection(direction: string): void
  onPlay(): void
  onPreview(midi: number): void
}): React.JSX.Element {
  const { root } = settings
  const chordView = module === 'chords' || overlay === 'chord'
  const options = chordView
    ? CHORDS
    : module !== 'positions'
      ? SCALES
      : system === 'caged'
        ? { major: SCALES.major! }
        : system === 'pent'
          ? { 'minor-pent': SCALES['minor-pent']!, 'major-pent': SCALES['major-pent']! }
          : system === 'three'
            ? Object.fromEntries(Object.entries(SCALES).filter(([, value]) => value.semitones.length === 7))
            : SCALES
  return (
    <div className="fl-details">
      <section className="fl-card fl-current">
        <h2>当前设置</h2>
        <div className="fl-current-top">
          <div className="fl-key-select">
            <LabSelect
              label="当前根音"
              value={String(root)}
              options={ROOTS.map((name, i) => ({ id: String(i), name }))}
              onChange={(v) => onRoot(Number(v))}
            />
            <LabSelect
              label="当前音阶或和弦"
              value={chordView ? settings.chord : settings.scale}
              options={Object.entries(options).map(([id, value]) => ({
                id,
                name: id === 'major' && !chordView ? 'Major' : value.name
              }))}
              onChange={(v) => onContent(v, chordView)}
            />
          </div>
          <button className="fl-play" aria-label={playing ? '停止试听调内音' : '试听调内音'} onClick={onPlay}>
            {playing ? <Square size={19} fill="currentColor" /> : <Play size={23} fill="currentColor" />}
          </button>
        </div>
        <div className="fl-current-bottom">
          <div className="fl-scale-notes">
            {materialNotes(root, material).map((name, i) => (
              <button key={i} onClick={() => onPreview(48 + root + material.semitones[i]!)}>
                <b>{name}</b>
                <span>{prettyDegree(material.degrees[i]!)}</span>
              </button>
            ))}
          </div>
          <div className="fl-play-options">
            <span>播放调内音</span>
            <LabSelect
              label="试听方向"
              value={direction}
              options={[
                { id: 'up', name: '上行' },
                { id: 'down', name: '下行' },
                { id: 'both', name: '往返' }
              ]}
              onChange={onDirection}
            />
          </div>
        </div>
      </section>
      <section className="fl-card fl-note-info">
        <div className="fl-card-title">
          <h2>音符信息</h2>
          <button
            className="fl-icon"
            aria-label="试听所选音符"
            disabled={!selected}
            onClick={() => selected && onPreview(selected.midi)}
          >
            <Volume2 size={18} />
          </button>
        </div>
        {selected ? (
          <div className="fl-note-content">
            <strong>{noteName(selected.midi, false)}</strong>
            <dl>
              <dt>音名</dt>
              <dd>{noteName(selected.midi, false)}</dd>
              <dt>音级</dt>
              <dd>
                {degreeFor(selected.midi, root, material)}
                {mod(selected.midi - root) === 0 ? '（Root）' : ''}
              </dd>
              <dt>音程</dt>
              <dd>{intervalNames[mod(selected.midi - root)]}</dd>
              <dt>所在弦</dt>
              <dd>{selected.string} 弦</dd>
              <dt>品位</dt>
              <dd>{selected.fret}</dd>
              <dt>音高</dt>
              <dd>
                {noteName(selected.midi)}（{frequency(selected.midi, a4).toFixed(1)} Hz）
              </dd>
            </dl>
          </div>
        ) : (
          <p className="fl-empty-info">点击指板，查看这个位置的音符。</p>
        )}
      </section>
      <section className="fl-card fl-shortcuts">
        <h2>快捷功能</h2>
        <div className="fl-quick-buttons">
          {[
            { id: 'scale', name: '显示调内音', icon: Guitar },
            { id: 'chord', name: '显示和弦音', icon: Guitar },
            { id: 'interval', name: '显示音阶', icon: ChartNoAxesColumnIncreasing },
            { id: 'none', name: '清除', icon: Eraser }
          ].map((item) => (
            <button
              key={item.id}
              aria-pressed={overlay === item.id}
              onClick={() => onOverlay(item.id as LabOverlay)}
            >
              <item.icon size={16} />
              {item.name}
            </button>
          ))}
        </div>
        <span className="fl-small-label">常用音符</span>
        <div className="fl-note-buttons">
          {LAB_NOTE_NAMES.map((name, i) => (
            <button
              key={name}
              aria-pressed={filter === 'single' ? single === i : root === i}
              onClick={() => {
                onSingle(i)
                onPreview(48 + i)
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
