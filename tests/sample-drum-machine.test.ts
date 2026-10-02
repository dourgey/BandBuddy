import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PADS, PAD_KEYS, SAMPLE_NOTES, capturePad, cloneDraft, defaultDrumState, drumStepTime, migrateLegacyDrums, presetDraft, quantizedStep, readDrumState, resizeDraft, saveDrumState, stepCount, writeHit } from '../src/renderer/src/sample-drums/drum-patterns.js'
import { resolveDrumAsset } from '../src/main/drum-assets.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

afterEach(() => vi.unstubAllGlobals())
describe('drum sequencing and pad capture', () => {
  it('migrates the original bitmask patterns without losing sample selections or swing', () => {
    const machine = migrateLegacyDrums(JSON.stringify({ drumMachine: { selectedPresetId: 'funk', drafts: { funk: { steps: { kick: 257, snare: 4112 }, sounds: { kick: 36, snare: 64 }, bpm: 104, swing: 0.6, volume: 0.65 } } } }))!
    expect(machine.selected).toBe('legacy-funk')
    expect(machine.draft.swing).toBe(40)
    expect(machine.draft.volume).toBe(0.65)
    expect(machine.draft.tracks[0]!.hits.filter(value => value > 0)).toHaveLength(2)
    expect(machine.draft.tracks[1]!.sample).toBe(64)
    machine.draft.tracks[0]!.hits[0] = 0
    expect(machine.presets[0]!.draft.tracks[0]!.hits[0]).toBe(0.7)
    expect(migrateLegacyDrums('{')).toBeNull()
  })
  it('maps all sixteen physical keys to real samples, with the core kit on the bottom row', () => {
    expect(PAD_KEYS.join('')).toBe('1234qwerasdfzxcv')
    expect(DEFAULT_PADS).toHaveLength(16)
    expect(new Set(DEFAULT_PADS).size).toBe(16)
    expect(DEFAULT_PADS.every(note => SAMPLE_NOTES.includes(note))).toBe(true)
    expect(DEFAULT_PADS.slice(12)).toEqual([36, 38, 42, 33])
  })
  it('changes meter and bar count without repeating or shifting existing hits', () => {
    const original = presetDraft()
    const twoBars = resizeDraft(original, 4, 2)
    expect(stepCount(twoBars)).toBe(32)
    expect(twoBars.tracks[0]!.hits.slice(0, 16)).toEqual(original.tracks[0]!.hits)
    expect(twoBars.tracks[0]!.hits.slice(16)).toEqual(Array(16).fill(0))
    expect(resizeDraft(twoBars, 3, 1).tracks.every(track => track.hits.length === 12)).toBe(true)
    expect(resizeDraft(twoBars, 2, 1).tracks.every(track => track.hits.length === 8)).toBe(true)
  })
  it('enforces hi-hat exclusivity using assigned samples rather than track names', () => {
    const original = presetDraft()
    const opened = writeHit(original, 'openHat', 0, 0.8)
    expect(opened.tracks.find(track => track.id === 'closedHat')!.hits[0]).toBe(0)
    expect(original.tracks.find(track => track.id === 'closedHat')!.hits[0]).toBe(0.7)
    const swapped = { ...opened, tracks: opened.tracks.map(track => track.id === 'clap' ? { ...track, sample: 42 } : track) }
    expect(writeHit(swapped, 'clap', 0, 0.6).tracks.find(track => track.id === 'openHat')!.hits[0]).toBe(0)
    expect(writeHit(original, 'snare', 99, 1)).toBe(original)
  })
  it('preserves a custom pad articulation by adding a dedicated track instead of replacing another drum', () => {
    const captured = capturePad(presetDraft(), 64, 15, 0.6)
    expect(captured.tracks.find(track => track.sample === 64)!.hits[15]).toBe(0.6)
    expect(captured.tracks.find(track => track.id === 'snare')!.sample).toBe(38)
    expect(capturePad(captured, 64, 0, 0.7).tracks).toHaveLength(9)
  })
  it('quantizes against swung audio time and wraps at a loop boundary', () => {
    const draft = { ...presetDraft(), swing: 100 }
    expect(drumStepTime(2, 120, 100)).toBe(0.375)
    expect(drumStepTime(4, 120, 100)).toBe(0.5)
    expect(quantizedStep(0.36, draft, 16)).toBe(2)
    expect(quantizedStep(1.99, draft, 16)).toBe(0)
    expect(quantizedStep(2.5, draft, 4)).toBe(4)
    expect(quantizedStep(3.99, resizeDraft(draft, 4, 2), 16)).toBe(0)
  })
  it('saves independent preset snapshots and validates corrupt or obsolete local storage', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) })
    const machine = defaultDrumState()
    machine.presets = [{ id: 'user-test', name: '我的节奏', draft: cloneDraft(machine.draft) }]
    machine.draft.tracks[0]!.hits[0] = 0.9
    expect(machine.presets[0]!.draft.tracks[0]!.hits[0]).toBe(0.7)
    machine.pads[0] = 64
    expect(saveDrumState(machine)).toBe(true)
    expect(readDrumState()).toEqual(machine)
    machine.pads[0] = 999
    saveDrumState(machine)
    expect(readDrumState()).toEqual(defaultDrumState())
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota') } })
    expect(saveDrumState(machine)).toBe(false)
  })
})
describe('actual drum assets and desktop access', () => {
  it('has all 34 actual FLAC files and matches the manifest hashes', () => {
    const root = path.resolve('src/renderer/public/woodshed/drums')
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { samples: { midiNote: number; file: string; sha256: string }[] }
    expect(manifest.samples).toHaveLength(34)
    expect(manifest.samples.map(sample => sample.midiNote).sort((a, b) => a - b)).toEqual(SAMPLE_NOTES)
    for (const sample of manifest.samples) expect(createHash('sha256').update(readFileSync(path.join(root, sample.file))).digest('hex')).toBe(sample.sha256)
  })
  it('rejects arbitrary files and encoded traversal in the desktop drum route', () => {
    const root = path.resolve('sample-root')
    expect(resolveDrumAsset(root, new URL('bandbuddy-media://drum/manifest.json'))).toBe(path.join(root, 'manifest.json'))
    expect(resolveDrumAsset(root, new URL('bandbuddy-media://drum/01-kicks/midi036__kick-studio-beater.flac'))).toBe(path.join(root, '01-kicks/midi036__kick-studio-beater.flac'))
    for (const route of ['bandbuddy-media://drum/%2e%2e%2fsecret.flac', 'bandbuddy-media://drum/01-kicks/%2e%2e%5csecret.flac', 'bandbuddy-media://drum/secret.json', 'bandbuddy-media://other/manifest.json', 'bandbuddy-media://drum/%ZZ']) expect(resolveDrumAsset(root, new URL(route))).toBeNull()
  })
})
