import manifest from '../../../../resources/learning/manifest.json' with { type: 'json' }

export type SystemId = 'shared' | 'guitar' | 'bass' | 'ukulele' | 'blues' | 'drums' | 'piano' | 'keyboard' | 'ensemble'
/** Legacy curriculum builders retain this shape for their exercise mappings. Reading uses document files. */
export interface Knowledge { id: string; title: string; paragraphs: string[]; example: string; note?: string; figure?: 'fretboard' | 'rhythm' | 'signal' | 'chords' }
export interface KnowledgeStage { goal?: string; title: string; nodes: Knowledge[] }
export interface LearningSystem { id: SystemId; title: string; description: string; context: string; stages: KnowledgeStage[] }
export interface KnowledgeReference { id: string; title: string; document: string }
export interface ReadingSystem extends Omit<LearningSystem, 'stages'> { stages: { title: string; goal?: string; nodes: KnowledgeReference[] }[] }
export const GUITAR_READING: Record<string, string> = Object.fromEntries(
  ['0-1', '1-1', '1-1', '1-2', '2-3', '2-2', '2-1', '3-1', '3-1', '4-1', '3-2', '4-2']
    .map((target, i) => [`guitar-${i + 1}`, `guitar-outline-${target}`])
)
export const LEARNING_SYSTEMS = manifest.systems as ReadingSystem[]
