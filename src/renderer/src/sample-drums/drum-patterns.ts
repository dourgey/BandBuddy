import { z } from 'zod'

export interface DrumSample { midiNote: number; file: string; nameZh: string; articulation: string }
export const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'] as const
// Common finger-drumming layout: core kit at the bottom, toms above, cymbals at the top.
export const DEFAULT_PADS = [49, 57, 51, 53, 37, 40, 54, 56, 43, 45, 47, 48, 36, 38, 42, 33]
export const SAMPLE_NOTES = [29, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 56, 57, 62, 64, 66, 67, 68, 69, 70, 71, 72]
export const DRUM_LANES = [
  { id: 'kick', name: '底鼓', sample: 36 }, { id: 'snare', name: '军鼓', sample: 38 },
  { id: 'closedHat', name: '闭镲', sample: 42 }, { id: 'openHat', name: '开镲', sample: 33 },
  { id: 'clap', name: '拍手', sample: 39 }, { id: 'lowTom', name: '低通鼓', sample: 43 },
  { id: 'highTom', name: '高通鼓', sample: 48 }, { id: 'cymbal', name: '碎音镲', sample: 49 }
] as const
export interface DrumTrack { id: string; name: string; sample: number; hits: number[] }
export interface DrumDraft { bpm: number; swing: number; volume: number; beats: number; bars: number; tracks: DrumTrack[] }
export interface SavedDrumPreset { id: string; name: string; draft: DrumDraft }
export interface DrumState { version: 2; selected: string; draft: DrumDraft; pads: number[]; presets: SavedDrumPreset[]; velocity: number; quantize: number; repeat: boolean }
export const DRUM_PRESETS = [
  { id: 'rock', name: '基础摇滚', bpm: 120, swing: 0 },
  { id: 'electronic', name: '电子', bpm: 124, swing: 0 },
  { id: 'hiphop', name: 'Hip-Hop', bpm: 88, swing: 20 },
  { id: 'shuffle', name: 'Shuffle', bpm: 98, swing: 66 }
] as const
export const stepCount = (draft: Pick<DrumDraft, 'beats' | 'bars'>): number => draft.beats * 4 * draft.bars
export const cloneDraft = (draft: DrumDraft): DrumDraft => ({ ...draft, tracks: draft.tracks.map(track => ({ ...track, hits: [...track.hits] })) })
export function presetDraft(id = 'rock'): DrumDraft {
  const preset = DRUM_PRESETS.find(item => item.id === id) ?? DRUM_PRESETS[0]!
  const pattern: Record<string, number[]> = id === 'electronic'
    ? { kick: [0, 4, 8, 12], clap: [4, 12], closedHat: [0, 4, 8, 12], openHat: [2, 6, 10, 14] }
    : id === 'hiphop' ? { kick: [0, 6, 10], snare: [4, 12], closedHat: [0, 2, 4, 6, 8, 10, 12, 14] }
      : { kick: [0, 8], snare: [4, 12], closedHat: [0, 2, 4, 6, 8, 10, 12, 14], cymbal: [0] }
  return { bpm: preset.bpm, swing: preset.swing, volume: 0.8, beats: 4, bars: 1,
    tracks: DRUM_LANES.map(lane => ({ ...lane, hits: Array.from({ length: 16 }, (_, i) => pattern[lane.id]?.includes(i) ? 0.7 : 0) })) }
}
export function resizeDraft(draft: DrumDraft, beats: number, bars: number): DrumDraft {
  return { ...draft, beats, bars, tracks: draft.tracks.map(track => ({ ...track,
    hits: Array.from({ length: beats * 4 * bars }, (_, i) => track.hits[i] ?? 0) })) }
}
export function drumStepTime(step: number, bpm: number, swing: number): number {
  const ratio = 0.5 + swing / 400
  const phase = [0, ratio / 2, ratio, ratio + (1 - ratio) / 2][step % 4]!
  return (Math.floor(step / 4) + phase) * 60 / bpm
}
export const CLOSED_HATS = [29, 30, 42, 44]
export const OPEN_HATS = [31, 32, 33, 34, 46]
export function writeHit(draft: DrumDraft, trackId: string, step: number, velocity: number): DrumDraft {
  if (!Number.isInteger(step) || step < 0 || step >= stepCount(draft)) return draft
  const target = draft.tracks.find(track => track.id === trackId)
  if (!target) return draft
  const opposite = CLOSED_HATS.includes(target.sample) ? OPEN_HATS : OPEN_HATS.includes(target.sample) ? CLOSED_HATS : []
  return { ...draft, tracks: draft.tracks.map(track => {
    if (track.id !== trackId && !(velocity > 0 && opposite.includes(track.sample))) return track
    const hits = [...track.hits]
    hits[step] = track.id === trackId ? velocity : 0
    return { ...track, hits }
  }) }
}
export function capturePad(draft: DrumDraft, sample: number, step: number, velocity: number): DrumDraft {
  let track = draft.tracks.find(item => item.sample === sample)
  if (!track) {
    track = { id: `sample-${sample}`, name: '打击垫', sample, hits: Array(stepCount(draft)).fill(0) }
    draft = { ...draft, tracks: [...draft.tracks, track] }
  }
  return writeHit(draft, track.id, step, velocity)
}
export function quantizedStep(elapsed: number, draft: DrumDraft, quantize: number): number {
  const length = stepCount(draft), duration = length / 4 * 60 / draft.bpm
  const within = ((elapsed % duration) + duration) % duration
  const stride = 16 / quantize
  let nearest = 0, distance = Infinity
  for (let i = 0; i <= length; i += stride) {
    const at = i === length ? duration : drumStepTime(i, draft.bpm, draft.swing)
    if (Math.abs(at - within) < distance) { nearest = i % length; distance = Math.abs(at - within) }
  }
  return nearest
}
const sampleSchema = z.number().int().refine(note => SAMPLE_NOTES.includes(note))
const draftSchema = z.object({ bpm: z.number().int().min(40).max(240), swing: z.number().min(0).max(100),
  volume: z.number().min(0).max(1), beats: z.union([z.literal(2), z.literal(3), z.literal(4)]), bars: z.union([z.literal(1), z.literal(2)]),
  tracks: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().max(80), sample: sampleSchema,
    hits: z.array(z.number().min(0).max(1)).min(8).max(32) })).min(1).max(42)
}).refine(draft => draft.tracks.every(track => track.hits.length === stepCount(draft)) && new Set(draft.tracks.map(track => track.id)).size === draft.tracks.length)
const stateSchema = z.object({ version: z.literal(2), selected: z.string().max(100), draft: draftSchema,
  pads: z.array(sampleSchema).length(16), presets: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(40), draft: draftSchema })).max(64),
  velocity: z.number().min(0.1).max(1), quantize: z.union([z.literal(4), z.literal(8), z.literal(16)]), repeat: z.boolean() })
export const DRUM_STORAGE_KEY = 'bandbuddy.drums.v2'
export function defaultDrumState(): DrumState { return { version: 2, selected: 'rock', draft: presetDraft(), pads: [...DEFAULT_PADS], presets: [], velocity: 0.7, quantize: 16, repeat: false } }
const legacyDraftSchema = z.object({
  steps: z.record(z.string(), z.number().int().min(0).max(65535)),
  sounds: z.record(z.string(), sampleSchema), bpm: z.number().int().min(40).max(240),
  swing: z.number().min(0.5).max(0.75), volume: z.number().min(0).max(1)
})
/** Keep previously edited nine-lane patterns when moving from the original drum machine. */
export function migrateLegacyDrums(raw: string | null): DrumState | null {
  try {
    const legacy = z.object({ drumMachine: z.object({ selectedPresetId: z.string(), drafts: z.record(z.string(), legacyDraftSchema) }) }).parse(JSON.parse(raw ?? 'null')).drumMachine
    const names: Record<string, string> = { pop: '流行', rock: '摇滚', funk: '放克', hiphop: 'Hip-Hop', house: 'House', disco: 'Disco', reggae: 'Reggae', shuffle: 'Shuffle' }
    const laneNames: Record<string, string> = { kick: '底鼓', snare: '军鼓', sidestick: '边击', clap: '拍手', closedHat: '闭镲', openHat: '开镲', tom: '通鼓', cymbal: '镲片', percussion: '打击乐' }
    const presets = Object.entries(legacy.drafts).slice(0, 64).map(([id, old]) => ({
      id: `legacy-${id}`, name: `原有预设 · ${names[id] ?? id}`,
      draft: { bpm: old.bpm, swing: Math.round((old.swing - 0.5) * 400), volume: old.volume, beats: 4, bars: 1,
        tracks: Object.entries(old.sounds).filter(([lane]) => typeof old.steps[lane] === 'number').map(([lane, sample]) => ({
          id: lane, name: laneNames[lane] ?? lane, sample, hits: Array.from({ length: 16 }, (_, step) => old.steps[lane]! & (1 << step) ? 0.7 : 0)
        })) }
    }))
    if (!presets.length) return null
    const selected = presets.find(preset => preset.id === `legacy-${legacy.selectedPresetId}`)
    return stateSchema.parse({ ...defaultDrumState(), presets, ...(selected ? { selected: selected.id, draft: cloneDraft(selected.draft) } : {}) })
  } catch { return null }
}
export function readDrumState(): DrumState {
  try {
    const raw = localStorage.getItem(DRUM_STORAGE_KEY)
    if (raw) return stateSchema.parse(JSON.parse(raw))
    return migrateLegacyDrums(localStorage.getItem('bandbuddy.woodshed.v1')) ?? defaultDrumState()
  } catch { return defaultDrumState() }
}
export function saveDrumState(state: DrumState): boolean {
  try { localStorage.setItem(DRUM_STORAGE_KEY, JSON.stringify(state)); return true } catch { return false }
}
