import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { LEARNING_SYSTEMS } from '../src/renderer/src/woodshed/knowledge.js'
import { loadLesson, loadLessonScore } from '../src/renderer/src/woodshed/lesson-library.js'

const root = resolve('resources/learning')
const views = ['guitar-electric', 'guitar-acoustic', 'bass', 'ukulele', 'drums', 'piano', 'keyboard'] as const
const elements = (e: Element, tag: string) => Array.from(e.getElementsByTagName(tag))
const value = (e: Element, tag: string) => elements(e, tag)[0]?.textContent ?? ''

describe('standalone textbook library', () => {
  it('loads every indexed lesson with complete text, correct identity, media and instrument variants', async () => {
    const indexed: string[] = []
    for (const system of LEARNING_SYSTEMS) for (const node of system.stages.flatMap(s => s.nodes)) {
      const doc = await loadLesson(node.document, node.id)
      indexed.push(node.document)
      expect(doc.title, node.id).toBe(node.title)
      expect(doc.sections.length, node.id).toBeGreaterThanOrEqual(4)
      expect(doc.sections.flatMap(s => s.paragraphs).join('').length, node.id).toBeGreaterThan(400)
      expect(doc.objectives.length, node.id).toBeGreaterThanOrEqual(2)
      expect(doc.steps.length, node.id).toBeGreaterThanOrEqual(3)
      expect(doc.mistakes.length, node.id).toBeGreaterThanOrEqual(2)
      expect(doc.checks.length, node.id).toBeGreaterThanOrEqual(2)
      for (const view of ['shared', 'blues', 'ensemble'].includes(system.id) ? views : system.id === 'guitar' ? views.slice(0, 2) : []) {
        expect(doc.contexts?.[view]?.paragraphs.join('').length, `${node.id}/${view}`).toBeGreaterThan(40)
      }
      for (const media of [...(doc.scores ?? []), ...(doc.diagrams ?? [])]) {
        expect(media.src, node.id).toMatch(/^(scores|diagrams)\/[a-z0-9-]+\.(musicxml|svg)$/)
        expect(existsSync(resolve(root, media.src)), `${node.id}/${media.src}`).toBe(true)
      }
      for (const score of doc.scores ?? []) expect(await loadLessonScore(score.src)).toContain('<score-partwise')
    }
    const actual = readdirSync(resolve(root, 'documents'), { recursive: true }).filter(f => String(f).endsWith('.json')).map(f => `documents/${String(f).replaceAll('\\', '/')}`)
    expect(new Set(actual)).toEqual(new Set(indexed))
  })
  it('rejects missing paths and mismatched documents instead of silently showing a guitar lesson', async () => {
    await expect(loadLesson('documents/shared/missing.json', 'missing')).rejects.toThrow('没有找到')
    await expect(loadLesson('documents/shared/shared-1.json', 'bass-1')).rejects.toThrow('格式')
    await expect(loadLessonScore('../missing.musicxml')).rejects.toThrow('没有找到')
  })
  it('parses every authored MusicXML asset and keeps every measure inside its declared meter', () => {
    for (const filename of readdirSync(resolve(root, 'scores')).filter(f => f.endsWith('.musicxml'))) {
      const xml = readFileSync(resolve(root, 'scores', filename), 'utf8')
      const parsed = new DOMParser({ onError: (level, message) => { throw new Error(`${filename}: ${level}: ${message}`) } }).parseFromString(xml, 'application/xml')
      expect(parsed.documentElement!.tagName).toBe('score-partwise')
      for (const part of elements(parsed.documentElement!, 'part')) {
        let divisions = 1, meter = 4
        for (const measure of elements(part, 'measure')) {
          divisions = Number(value(measure, 'divisions')) || divisions
          if (value(measure, 'beats')) meter = value(measure, 'beats').split('+').reduce((sum, n) => sum + Number(n), 0) * 4 / Number(value(measure, 'beat-type'))
          let cursor = 0, maximum = 0
          for (const child of Array.from(measure.childNodes).filter((e): e is Element => e.nodeType === 1)) {
            const duration = Number(value(child, 'duration')) / divisions
            if (child.tagName === 'backup') cursor -= duration
            else if (child.tagName === 'forward' || child.tagName === 'note' && !elements(child, 'chord').length && !elements(child, 'grace').length) cursor += duration
            expect(cursor, `${filename}/${measure.getAttribute('number')}`).toBeGreaterThanOrEqual(-1e-6)
            maximum = Math.max(maximum, cursor)
          }
          expect(maximum, `${filename}/${measure.getAttribute('number')}`).toBeLessThanOrEqual(meter + 1e-6)
          if (measure.getAttribute('implicit') !== 'yes') expect(maximum, `${filename}/${measure.getAttribute('number')}`).toBeCloseTo(meter, 6)
        }
      }
    }
  })
})
