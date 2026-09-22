import { Select } from '../components/ui/Select.js'
import { ArrowUpRight, Route, Zap } from 'lucide-react'
import { GUITAR_PROJECTS, type ElectricConfig, type GuitarProject } from './electric.js'
import type { Lesson } from './types.js'
import './electric.css'

export function ElectricProjects({
  onSelect,
  lessons
}: {
  onSelect: (lesson: Lesson) => void
  lessons: readonly Lesson[]
}): React.JSX.Element {
  return (
    <details className="ws-project-library">
      <summary>
        <span>
          <Zap size={17} /> 电吉他项目架
        </span>
        <small>12 个项目 · 36 个原创分层谱例</small>
      </summary>
      <p>按想解决的问题选一个项目。先拆解，再组合，最后带回音乐；每个版本都有具体的聆听目标。</p>
      <div className="ws-project-grid">
        {GUITAR_PROJECTS.map((project) => (
          <button
            key={project.id}
            onClick={() =>
              onSelect(
                lessons.find(
                  (l) =>
                    l.guitarProjectId === project.id &&
                    (project.category !== '机能项目' || l.category === '机能项目')
                )!
              )
            }
          >
            <small>
              {project.category} · {project.meter}
            </small>
            <b>
              {project.title}
              <ArrowUpRight size={15} />
            </b>
            <span>{project.skill}</span>
          </button>
        ))}
      </div>
    </details>
  )
}
export function ElectricProjectIntro({
  project,
  settings,
  onChange,
  bpm,
  onBpm
}: {
  project: GuitarProject
  settings: ElectricConfig
  onChange: (value: ElectricConfig) => void
  bpm: number
  onBpm: (value: number) => void
}): React.JSX.Element {
  return (
    <section className="ws-electric-project">
      <div className="ws-project-title">
        <Route size={22} />
        <div>
          <small>{project.category} · 原创技能项目</small>
          <h3>{project.title}</h3>
        </div>
        <span className="ws-tag">{project.meter} · 标准六弦</span>
      </div>
      <p>{project.purpose}</p>
      <div className="ws-project-stages" aria-label="项目分层版本">
        {project.stages.map((s, i) => (
          <button
            key={s.title}
            aria-pressed={settings.stage === i}
            onClick={() => onChange({ ...settings, stage: i })}
          >
            <span>0{i + 1}</span>
            <b>{s.title}</b>
          </button>
        ))}
      </div>
      <div className="ws-project-task">
        <b>这一遍听什么</b>
        <p>{project.stages[settings.stage]!.task}</p>
        <small>{project.check}</small>
      </div>
      <div className="ws-form-row">
        <label className="ws-field">
          项目速度 BPM
          <input
            aria-label="项目速度 BPM"
            type="number"
            min={30}
            max={240}
            value={bpm}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onBpm(Math.max(30, Math.min(240, Math.round(n))))
            }}
          />
        </label>
        <label className="ws-field">
          整体移位
          <Select
            aria-label="项目整体移位"
            value={settings.shift}
            onChange={(e) => onChange({ ...settings, shift: Number(e.target.value) })}
          >
            {Array.from({ length: 13 }, (_, i) => i - 5).map((v) => (
              <option key={v} value={v}>
                {v === 0 ? '原位' : `${v > 0 ? '+' : ''}${v} 品 · 精确移调`}
              </option>
            ))}
          </Select>
        </label>
        <small>保留原谱的弦组与节奏。BPM 以四分音符为一拍；移位后的空弦变为按弦，音色与手感会变化。</small>
      </div>
      {project.category === '后摇' && (
        <div className="ws-delay-recipe">
          <b>效果器时间参考</b>
          <span>四分 {Math.round(60000 / bpm)} ms</span>
          <span>附点八分 {Math.round(45000 / bpm)} ms</span>
          <span>八分 {Math.round(30000 / bpm)} ms</span>
          <small>跟随当前设定速度；逐轮升速时需同步调整外部效果器。示范为干声，不自动添加延迟。</small>
        </div>
      )}
      <details>
        <summary>实琴音色与动作提示</summary>
        <p>{project.tone}</p>
        <p>
          示范表达音高、节奏、重音与掌根短音，连奏／点弦的动作与音色差异请在实琴上检验。听示范后切换“跟练”；“伴奏应用”提供节奏底，和声由你按原谱演奏。
        </p>
      </details>
    </section>
  )
}
