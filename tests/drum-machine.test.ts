import { describe, expect, it } from 'vitest'
import { DRUM_LANES, DRUM_PRESETS, defaultDrumDraft, drumStepTime, toggleDrumStep } from '../src/renderer/src/woodshed/drum-patterns.js'
import { tunerNeedleAngle } from '../src/renderer/src/woodshed/pitch.js'
import { decodePreferences, defaults } from '../src/renderer/src/woodshed/preferences.js'

describe('drum presets and saved edits', () => {
  it('provides eight playable patterns with nine valid lanes', () => {
    expect(DRUM_PRESETS).toHaveLength(8)
    for (const preset of DRUM_PRESETS) {
      const draft = defaultDrumDraft(preset.id)
      expect(Object.keys(draft.steps)).toHaveLength(DRUM_LANES.length)
      expect(Object.values(draft.steps).some(Boolean)).toBe(true)
      expect(draft.steps.closedHat & draft.steps.openHat).toBe(0)
      expect(draft.bpm).toBeGreaterThanOrEqual(40)
    }
  })
  it('edits one cell and prevents simultaneous open and closed hats', () => {
    const original = defaultDrumDraft('pop').steps
    const opened = toggleDrumStep(original, 'openHat', 0)
    expect(opened.openHat & 1).toBe(1)
    expect(opened.closedHat & 1).toBe(0)
    expect(original.closedHat & 1).toBe(1)
    expect(toggleDrumStep(opened, 'closedHat', 0).openHat & 1).toBe(0)
  })
  it('swings eighth offbeats while preserving each quarter note', () => {
    expect(drumStepTime(2, 120, 0.5)).toBeCloseTo(0.25)
    expect(drumStepTime(2, 120, 2 / 3)).toBeCloseTo(1 / 3)
    expect(drumStepTime(4, 120, 2 / 3)).toBeCloseTo(0.5)
    expect(drumStepTime(16, 120, 2 / 3)).toBeCloseTo(2)
  })
  it('keeps old woodshed preferences when the drum machine field is absent', () => {
    const old = defaults()
    const { drumMachine: _drumMachine, ...legacy } = old
    const restored = decodePreferences(JSON.stringify({ ...legacy, a4: 442, favorites: ['shared-1'] }))
    expect(restored.a4).toBe(442)
    expect(restored.favorites).toEqual(['shared-1'])
    expect(restored.drumMachine).toEqual({ selectedPresetId: 'pop', drafts: {} })
  })
  it('restores per-preset edits and excludes unknown preset ids', () => {
    const saved = defaults()
    const edited = defaultDrumDraft('funk')
    edited.steps.kick = 123
    saved.drumMachine = { selectedPresetId: 'funk', drafts: { funk: edited, invalid: edited } as never }
    const restored = decodePreferences(JSON.stringify(saved))
    expect(restored.drumMachine.drafts.funk?.steps.kick).toBe(123)
    expect(Object.keys(restored.drumMachine.drafts)).toEqual(['funk'])
  })
})

describe('tuner pointer', () => {
  it('clamps the physical needle to the scale ends', () => {
    expect(tunerNeedleAngle(-100)).toBe(-90)
    expect(tunerNeedleAngle(-5)).toBe(-9)
    expect(tunerNeedleAngle(0)).toBe(0)
    expect(tunerNeedleAngle(50)).toBe(90)
  })
})
