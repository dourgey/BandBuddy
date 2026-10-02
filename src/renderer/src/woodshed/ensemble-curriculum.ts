import source from './ensemble-source.json' with { type: 'json' }
import { MODULE_NOTES, MODULE_MISTAKES } from './ensemble-notes.js'
import { exerciseScores, type EnsembleInstrument, type EnsembleScore } from './ensemble-material.js'
import type { Knowledge, LearningSystem } from './knowledge.js'

export const ENSEMBLE_INSTRUMENTS = [
 { id: 'drums' as const, title: '鼓', description: '拍点、四肢协调、律动与完整鼓组编配', tuning: '架子鼓 · 原声鼓与电子鼓', prefix: 'D' },
 { id: 'piano' as const, title: '钢琴', description: '读谱、触键、多声部与独立作品', tuning: '钢琴 · 实际音高 · 中央 C = C4', prefix: 'P' },
 { id: 'keyboard' as const, title: '现代键盘', description: '和弦伴奏、音色、编配与现场系统', tuning: '现代键盘 · 实际音高 · 自动伴奏为可选支线', prefix: 'K' }
]
export type TaskKind = 'performance' | 'listening' | 'analysis' | 'equipment' | 'project'
export interface EnsembleExercise {
 id: string; sourceId: string; instrument: EnsembleInstrument; module: string; title: string;
 bpm: number; kind: TaskKind; method: string; material: string; prerequisites: string;
 milestones: string[]; knowledge: string[]; variants: EnsembleScore[]; transfer: string; stage: number
}
// Each concept enters at its own stage; later techniques do not become prerequisites for beginners.
const STAGES: Record<string, number[]> = {
 D01:[1,1],D02:[1,3,6],D03:[1,5],D04:[2,5],D05:[2,4],D06:[5,5],D07:[3,3],D08:[2,4],D09:[6,7],D10:[6,6],D11:[6,8],D12:[1,7],
 P01:[1,2],P02:[1,2],P03:[3,6],P04:[2,3],P05:[2,5],P06:[4,4],P07:[3,4],P08:[6,6],P09:[5,5],P10:[6,6],P11:[2,6],P12:[7,7],
 K01:[1,3],K02:[1,4],K03:[2,4],K04:[3,2],K05:[4,6],K06:[4,6],K07:[5,5],K08:[5,5],K09:[5,6],K10:[1,7],K11:[2,6],K12:[7,7]
}
const sourceModule = (id: string) => source.modules.find(m => m.id === id)!
const conceptId = (module: string, n: number) => `ensemble-${module}-${n + 1}`
function concepts(module: string): Knowledge[] {
 return MODULE_NOTES[module]!.map(([title, paragraph, example], n) => ({
  id: conceptId(module, n), title, paragraphs: [paragraph], example,
  note: MODULE_MISTAKES[module],
  moduleCode: module
 }))
}
export const COMMON_STAGES = source.modules.filter(m => m.id.startsWith('C')).map(m => ({ title: `${m.id} ${m.title}`, nodes: concepts(m.id) }))
export const ENSEMBLE_SYSTEMS: LearningSystem[] = ENSEMBLE_INSTRUMENTS.map(instrument => ({
 id: instrument.id, title: instrument.title, description: instrument.description, context: instrument.tuning,
 stages: source.stages.filter(s => s.id.startsWith(instrument.prefix)).map((s, i) => ({
  title: s.title, goal: s.goal,
  nodes: [
   ...source.modules.filter(m => m.id.startsWith(instrument.prefix)).flatMap(m => concepts(m.id).filter((_, n) => STAGES[m.id]![n] === i + 1)),
   { id: `ensemble-${s.id}`, title: `阶段应用：${s.title}`, paragraphs: [s.focus, '把本阶段的能力放回完整音乐中。先保留结构和主要声部，结束后再定位一个需要修正的问题。'], example: s.goal, note: '理解、分解、稳定、应用、迁移与保持可以分别发展；路线提供建议顺序，不锁定内容。' },
   ...(i === 7 ? source.branches.filter(b => b.prefix === instrument.prefix).map((b, n) => ({ id: `ensemble-${instrument.prefix}-branch-${n + 1}`, title: `方向选择：${b.title}`, paragraphs: [`本方向深化：${b.detail}。`, '选择一首难度合适的作品，先分析该方向的声音和角色，再挑选对应专项。技术选择服务作品，不要求把所有分支依次刷完。'], example: `交付一段${b.title}的完整演奏或编配，标明段落、关键处理和采用的材料，录音后对照「${b.detail}」逐项复盘。`, note: '方向可并行选择，不能把分支专长当作所有乐器学习者的统一毕业条件。' })) : [])
  ]
 }))
}))

function taskKind(id: string, title: string): TaskKind {
 if (/^(D12|K08|K09|K10|K11|K12)/.test(id)) return 'equipment'
 if (/听写|听辨|模仿|听学|内听|分声部听取|包络辨识/.test(title)) return 'listening'
 if (/结构|标注|标谱|分析|诊断|识别|构建|复述|复盘|方案|图形/.test(title)) return 'analysis'
 if (/完整|编配|编鼓|独奏曲线|工程|曲目组/.test(title)) return 'project'
 return 'performance'
}
function transferFor(kind: TaskKind, instrument: EnsembleInstrument): string {
 if (kind === 'equipment') return '保存当前设置并记下信号路径；重新启动或重新加载后恢复同一结果，核对音量与控制响应。'
 if (kind === 'listening') return '换一条没有练过的同难度短材料，先听后复现；减少一次提示，核对具体差异。'
 if (kind === 'analysis') return '换一段同难度材料，独立完成相同分析并说明依据，再用实际声音核对。'
 if (kind === 'project') return '从另一个段落开始，保留结构与结束方式；完成不中断呈现并记录一个具体问题。'
 return instrument === 'drums' ? '保持节奏与长度，只改变一个鼓件分配；接回熟悉歌曲的段落边界，隔日再试。' : '保持节奏与声音目标，只换到一个熟悉调；用于一个短乐句，隔日从另一入口开始。'
}
export const ENSEMBLE_EXERCISES: EnsembleExercise[] = ENSEMBLE_INSTRUMENTS.flatMap(instrument => source.exercises
 .filter(e => e.id.startsWith(instrument.prefix) || e.id.startsWith('C'))
 .map(e => {
  const moduleId = e.id.slice(0, 3), module = sourceModule(moduleId), notes = MODULE_NOTES[moduleId]!
  const n = Math.min(notes.length - 1, Math.floor((Number(e.id.slice(-2)) - 1) * notes.length / source.exercises.filter(x => x.id.startsWith(moduleId + '-')).length))
  const kind = taskKind(e.id, e.title)
  const variants = exerciseScores(e.id, instrument.id)
  return {
   id: `${instrument.id}-${e.id}`, sourceId: e.id, instrument: instrument.id, module: `${moduleId} ${module.title}`, title: e.title,
   bpm: e.id === 'D07-02' ? 70 : 60, kind, method: e.method,
   material: variants[0]?.description ?? notes[n]![2],
   prerequisites: moduleId.startsWith('C') ? '从两小节或少量材料开始；已有能力可直接复测。' : `先理解「${notes[0]![0]}」；${moduleId === 'K11' ? '使用具备自动伴奏功能的设备，并确认当前和弦识别模式。' : '先单独完成各声部或动作，再组合；先修提供建议，不锁定练习。'}`,
   milestones: [e.check || module.practiceCheck, `${module.goal}。相同条件下重复完成，并在隔日复测；保留实际声音或操作记录。`, transferFor(kind, instrument.id)],
   knowledge: [conceptId(moduleId, n)], variants, transfer: transferFor(kind, instrument.id), stage: STAGES[moduleId]?.[n] ?? 1
  }
 }))
for (const instrument of ENSEMBLE_INSTRUMENTS) {
 for (const [n, branch] of source.branches.filter(b => b.prefix === instrument.prefix).entries()) {
  ENSEMBLE_EXERCISES.push({ id: `${instrument.id}-branch-${n + 1}`, sourceId: `${instrument.prefix}-B${n + 1}`, instrument: instrument.id,
   module: '可选风格与方向', title: branch.title, bpm: 60, kind: 'project', method: `围绕${branch.detail}，准备一段完整作品或编配。`,
   material: `先选一首已学习风格的短曲，标出段落和关键声部；围绕「${branch.detail}」设计处理。`, prerequisites: '基础拍点和本方向所需的声部能分别完成；复杂技术按作品需要选择。',
   milestones: ['说清所选材料的结构与本乐器角色，完成简化版本。', `在不中断呈现中听出${branch.detail}，保留原始录音。`, '换一个入口或编制再次执行，比较处理差异并安排下一项专项。'],
   knowledge: [`ensemble-${instrument.prefix}-branch-${n + 1}`], variants: [], transfer: transferFor('project', instrument.id), stage: 8 })
 }
 for (const [i, stage] of source.stages.filter(s => s.id.startsWith(instrument.prefix)).entries()) {
  ENSEMBLE_EXERCISES.push({ id: `${instrument.id}-${stage.id}`, sourceId: stage.id, instrument: instrument.id,
   module: '阶段应用与完整项目', title: `${stage.id} ${stage.title}`, bpm: 60, kind: 'project', method: stage.goal,
   material: stage.focus, prerequisites: '先选本阶段已能分解完成的材料；可简化声部，保留完整结构。',
   milestones: [stage.goal, '按预定开始、段落与结束连续呈现；保留未经修正的录音或操作记录。', '换一个入口或场景再次完成，记录问题位置、原因假设及下一项专项。'],
   knowledge: [`ensemble-${stage.id}`], variants: [], transfer: transferFor('project', instrument.id), stage: i + 1 })
 }
}
export const ENSEMBLE_PREREQUISITES = source.prerequisites
export function ensembleExerciseForKnowledge(id: string): EnsembleExercise | undefined { return ENSEMBLE_EXERCISES.find(e => e.knowledge.includes(id)) }
export function ensembleKnowledgeSystem(id: string): string { return id.startsWith('ensemble-C') ? 'ensemble' : id.startsWith('ensemble-D') ? 'drums' : id.startsWith('ensemble-P') ? 'piano' : 'keyboard' }
