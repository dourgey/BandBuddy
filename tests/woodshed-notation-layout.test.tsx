// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { addTextbookTab, tabFirst } from '../src/renderer/src/woodshed/notation-layout.js'
import { NotationBody, useNotationCapability } from '../src/renderer/src/woodshed/NotationBody.js'
import { exerciseToMusicXml } from '../src/renderer/src/woodshed/musicxml.js'
import { PRACTICE_EXERCISES, practiceTuning } from '../src/renderer/src/woodshed/practice-curriculum.js'
import { DEFAULT_EXERCISE } from '../src/renderer/src/woodshed/types.js'

afterEach(() => { cleanup(); localStorage.clear() })
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')
function notes(xml: string, staff: number) {
  const result: string[] = []; let divisions = 1
  for (const measure of parse(xml).querySelectorAll('measure')) {
    divisions = Number(measure.querySelector('divisions')?.textContent || divisions)
    let cursor = 0, last = 0
    for (const node of measure.children) {
      const duration = Number(node.querySelector('duration')?.textContent || 0) / divisions
      if (node.tagName === 'backup') cursor -= duration
      if (node.tagName === 'forward') cursor += duration
      if (node.tagName !== 'note') continue
      if (!node.querySelector('chord')) { last = cursor; cursor += duration }
      if (Number(node.querySelector('staff')?.textContent || 1) === staff) result.push([measure.getAttribute('number'), last, duration, node.querySelector('pitch')?.textContent, node.querySelector('rest') ? 'rest' : '', node.querySelector('technical')?.textContent].join('|'))
    }
  }
  return result
}
describe('instrument-first notation', () => {
  it('preserves every authored TAB note, rest and timing with either staff setting', () => {
    for (const file of readdirSync('resources/learning/scores').filter(f => f.endsWith('.musicxml'))) {
      const raw = readFileSync(`resources/learning/scores/${file}`, 'utf8')
      if (/piano|keyboard|drums|ensemble/.test(file)) continue
      const instrument = file.includes('ukulele') ? 'ukulele' : file.includes('bass') ? 'bass' : 'guitar-electric'
      let xml: string
      try { xml = addTextbookTab(raw, instrument) } catch (e) { throw new Error(file + ': ' + e) }
      expect(parse(xml).querySelector('clef[number="2"] sign')?.textContent, file).toBe('TAB')
      expect(notes(xml, 1), file).toEqual(notes(raw, 1))
      const strings = instrument === 'guitar-electric' ? 6 : 4
      for (const measure of parse(xml).querySelectorAll('measure')) {
        let used = new Set<string>()
        for (const note of measure.querySelectorAll('note')) {
          if (note.querySelector('staff')?.textContent !== '2' || !note.querySelector('pitch')) continue
          if (!note.querySelector('chord')) used = new Set()
          const string = note.querySelector('technical string')!.textContent!
          expect(Number(string)).toBeGreaterThanOrEqual(1); expect(Number(string)).toBeLessThanOrEqual(strings)
          expect(used.has(string), file).toBe(false); used.add(string)
        }
      }
      const clef = [...parse(xml).querySelectorAll('clef')].find(c => c.querySelector('sign')?.textContent === 'TAB')
      if (!clef) continue
      const original = Number(clef.getAttribute('number') || 1)
      for (const visible of [false, true]) {
        const next = tabFirst(xml, visible)
        expect(notes(next.xml, 1), file).toEqual(notes(xml, original))
        expect(parse(next.xml).querySelector('clef[number="1"] sign')?.textContent, file).toBe('TAB')
        if (!visible) expect(parse(next.xml).querySelectorAll('clef').length, file).toBe(1)
      }
    }
  }, 20000)
  it('remaps playback anchors for generated string exercises', () => {
    for (const exercise of PRACTICE_EXERCISES) for (const variant of exercise.variants) {
      const document = exerciseToMusicXml(variant.events, practiceTuning(exercise.instrument), { ...DEFAULT_EXERCISE, meter: variant.meter, pattern: 'scale' } as typeof DEFAULT_EXERCISE)
      const next = tabFirst(document.xml, false, document.anchors)
      if (!next.hasTab) continue
      expect(next.anchors?.map(a => a.id)).toEqual(document.anchors.filter(a => a.staff === 2).map(a => a.id))
      expect(next.anchors?.every(a => a.staff === 1)).toBe(true)
    }
  }, 20000)
  it('locks staff-only chapters on without changing the preference for chapters with TAB', () => {
    function ScoreCapability({ alternative }: { alternative: boolean }) { useNotationCapability(alternative); return <p>谱例</p> }
    localStorage.setItem('bandbuddy.notation.staff.piano', 'false')
    const view = render(<NotationBody instrument="piano"><ScoreCapability alternative={false} /></NotationBody>)
    const toggle = screen.getByRole('switch') as HTMLButtonElement
    expect(toggle.textContent).toBe('显示五线谱')
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    view.rerender(<NotationBody instrument="piano"><ScoreCapability alternative /></NotationBody>)
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.textContent).toBe('显示五线谱')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    view.rerender(<NotationBody instrument="piano"><ScoreCapability alternative /><ScoreCapability alternative={false} /></NotationBody>)
    expect(toggle.disabled).toBe(false)
  })
  it('defaults to TAB for strings and keeps drums on staff, and remembers each instrument', () => {
    const view = render(<NotationBody instrument="bass">知识</NotationBody>)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch'))
    view.rerender(<NotationBody instrument="piano">练习</NotationBody>)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch'))
    localStorage.setItem('bandbuddy.notation.staff.drums', 'false')
    view.rerender(<NotationBody instrument="drums">知识</NotationBody>)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    view.rerender(<NotationBody instrument="bass">练习</NotationBody>)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })
})
