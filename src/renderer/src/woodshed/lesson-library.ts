/// <reference types="vite/client" />
import type { LessonDocument } from './lesson-document.js'

// Keep this root identical for Vite's development server, tests and packaged builds.
const prefix = '../../../../resources/learning/'
const documents = import.meta.glob<LessonDocument>('../../../../resources/learning/documents/**/*.json', { import: 'default' })
const scores = import.meta.glob<string>('../../../../resources/learning/scores/*.musicxml', { query: '?raw', import: 'default' })
const diagrams = import.meta.glob<string>('../../../../resources/learning/diagrams/*.svg', { query: '?url', import: 'default', eager: true })

export async function loadLesson(path: string, expectedId: string): Promise<LessonDocument> {
  const load = documents[prefix + path]
  if (!load) throw new Error('没有找到这篇教材，请检查教材目录。')
  const lesson = await load()
  if (lesson.id !== expectedId || !lesson.title || !Array.isArray(lesson.sections) || !Array.isArray(lesson.steps)) throw new Error('教材内容格式不正确。')
  return lesson
}
export async function loadLessonScore(path: string): Promise<string> {
  const load = scores[prefix + path]
  if (!load) throw new Error('没有找到这份谱例。')
  return load()
}
export function lessonDiagramUrl(path: string): string | undefined { return diagrams[prefix + path] }
