import { expect, it } from 'vitest'
import { createTunerModeGate, hasStrongPolyEvidence } from '../src/renderer/src/woodshed/tuner-mode.js'

it('requires more than 500ms of uninterrupted evidence in both directions', () => {
  const gate = createTunerModeGate()
  for (const time of [0, 100, 200, 300, 400, 500]) expect(gate.update('poly', time)).toBe('mono')
  expect(gate.update('poly', 501)).toBe('poly')
  expect(gate.update('mono', 600)).toBe('poly')
  gate.update(null, 700)
  for (const time of [800, 900, 1000, 1100, 1200, 1300]) expect(gate.update('mono', time)).toBe('poly')
  expect(gate.update('mono', 1301)).toBe('mono')
})

it('does not count missing analyser time, weak detections or a periodic single string as poly input', () => {
  const gate = createTunerModeGate()
  expect(gate.update('poly', 0)).toBe('mono')
  expect(gate.update('poly', 600)).toBe('mono')
  const string = (confidence: number) => ({ midi: 40, hz: 82.4, cents: 0, confidence })
  expect(hasStrongPolyEvidence([string(1), string(0.4)], 0.7)).toBe(false)
  expect(hasStrongPolyEvidence([string(1), string(0.9)], 0.99)).toBe(false)
  expect(hasStrongPolyEvidence([string(1), string(0.9)], 0.7)).toBe(true)
})
