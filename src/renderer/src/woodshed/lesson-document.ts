/** The authored lesson format in resources/learning. Paths are relative to that directory. */
export type LessonInstrument = 'guitar-electric' | 'guitar-acoustic' | 'bass' | 'ukulele' | 'drums' | 'piano' | 'keyboard'
export interface LessonSection { title: string; paragraphs: string[] }
export interface LessonScore { src: string; caption: string; instruments?: LessonInstrument[] }
export interface LessonDiagram { src: string; alt: string; caption: string; instruments?: LessonInstrument[] }
export interface LessonContext { label: string; paragraphs: string[]; example?: string; steps?: string[] }
export interface LessonDocument {
  id: string
  title: string
  summary: string
  objectives: string[]
  sections: LessonSection[]
  contexts?: Partial<Record<LessonInstrument, LessonContext>>
  example: string
  steps: string[]
  mistakes: { problem: string; correction: string }[]
  checks: string[]
  scores?: LessonScore[]
  diagrams?: LessonDiagram[]
  references?: { title: string; url: string }[]
}
