import { describe, expect, it } from 'vitest'
import source from '../src/renderer/src/woodshed/ensemble-source.json' with { type: 'json' }
import { ENSEMBLE_EXERCISES, ENSEMBLE_SYSTEMS, COMMON_STAGES } from '../src/renderer/src/woodshed/ensemble-curriculum.js'
import { LEARNING_SYSTEMS } from '../src/renderer/src/woodshed/knowledge.js'
import { measureBeats } from '../src/renderer/src/woodshed/ensemble-material.js'

describe('drum, piano and keyboard curriculum', () => {
 it('preserves every supplied module and exercise and gives each route eight stage tasks', () => {
  expect(source.modules).toHaveLength(44)
  expect(source.exercises).toHaveLength(243)
  expect(COMMON_STAGES).toHaveLength(8)
  for (const e of source.exercises) expect(ENSEMBLE_EXERCISES.some(x => x.sourceId === e.id)).toBe(true)
  for (const s of ENSEMBLE_SYSTEMS) {
   expect(s.stages).toHaveLength(8)
   for (const stage of s.stages) { expect(stage.nodes.length).toBeGreaterThan(0); expect(stage.goal!.length).toBeGreaterThan(10) }
   expect(ENSEMBLE_EXERCISES.filter(e => e.instrument === s.id && /-S\d$/.test(e.sourceId))).toHaveLength(8)
  }
 })
 it('has unique identifiers, valid bidirectional links and real task instructions', () => {
  const nodes = LEARNING_SYSTEMS.flatMap(s => s.stages.flatMap(s => s.nodes))
  expect(new Set(nodes.map(n => n.id)).size).toBe(nodes.length)
  expect(new Set(ENSEMBLE_EXERCISES.map(e => e.id)).size).toBe(ENSEMBLE_EXERCISES.length)
  for (const e of ENSEMBLE_EXERCISES) {
   expect(e.method.length).toBeGreaterThan(8); expect(e.material.length).toBeGreaterThan(8)
   expect(e.milestones).toHaveLength(3)
   for (const id of e.knowledge) expect(nodes.some(n => n.id === id), `${e.id} -> ${id}`).toBe(true)
  }
  for (const n of nodes.filter(n => n.id.startsWith('ensemble-'))) expect(ENSEMBLE_EXERCISES.some(e => e.knowledge.includes(n.id)), n.id).toBe(true)
 })
 it('keeps all authored events inside the meter and hands independent without string positions', () => {
  for (const e of ENSEMBLE_EXERCISES) for (const v of e.variants) {
   const length = measureBeats(v.meter) * v.bars
   expect(v.beatUnit).toBeGreaterThan(0)
   expect(new Set(v.events.map(n => n.id)).size, e.id).toBe(v.events.length)
   for (const n of v.events) {
    expect(n.beat).toBeGreaterThanOrEqual(0); expect(n.duration).toBeGreaterThan(0)
    expect(n.beat + n.duration, `${e.id}/${v.name}/${n.id}`).toBeLessThanOrEqual(length + .001)
    if (n.drum) expect(n.notes).toEqual([])
    else for (const midi of n.notes) { expect(Number.isInteger(midi)).toBe(true); expect(midi).toBeGreaterThanOrEqual(21); expect(midi).toBeLessThanOrEqual(108) }
   }
   for (const hand of ['R', 'L']) {
    const events = v.events.filter(n => !n.drum && n.hand === hand).sort((a, b) => a.beat - b.beat)
    for (let i = 1; i < events.length; i++) expect(events[i]!.beat).toBeGreaterThanOrEqual(events[i - 1]!.beat + events[i - 1]!.duration)
   }
  }
 })
 it('implements the three reference exercises without changing their musical content', () => {
  const drums = ENSEMBLE_EXERCISES.find(e => e.sourceId === 'D07-02')!.variants[0]!
  expect(drums.bars).toBe(4)
  expect(drums.events.filter(e => e.beat >= 14)).toHaveLength(8)
  const piano = ENSEMBLE_EXERCISES.find(e => e.sourceId === 'P06-01')!.variants[0]!
  expect(piano.events.filter(e => e.hand === 'L').map(e => e.notes[0])).toEqual([48,45,41,43])
  expect(piano.events.filter(e => e.hand === 'R').map(e => e.notes[0])).toEqual([64,67,64,60,64,69,64,60,65,69,65,60,62,67,65,59])
  const keyboard = ENSEMBLE_EXERCISES.find(e => e.sourceId === 'K02-04')!.variants
  expect(keyboard[0]!.events.filter(e => e.hand === 'R').map(e => e.notes)).toEqual([[53,60],[53,59],[52,59],[52,59]])
  expect(keyboard[1]!.events.some(e => e.hand === 'L')).toBe(false)
 })
})
