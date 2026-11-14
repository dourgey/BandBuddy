import { z } from 'zod'

export const SCORES_CHANNEL = 'scores:command'
export const SCORES_CHANGED = 'scores:changed'
export const MUSCRIPTOR_REVISION = '8a1ef88672cc23c26619adaff37ec48d82c0b906'
export type ScoreModel = 'small' | 'medium' | 'large'
export interface ScoreNote { id: string; pitch: number; start: number; end: number; velocity: number; beat?: number; durationBeats?: number; string?: number; fret?: number }
export interface ScoreTrack { id: string; sourceId: string; name: string; instrument: string; program: number; isDrum: boolean; notes: ScoreNote[] }
export interface TempoMap { points: { time: number; beat: number }[]; bpm: number; numerator: number; denominator: number; firstDownbeat: number; provisional: boolean }
export interface ScoreData { version: 1; duration: number; tracks: ScoreTrack[]; tempo: TempoMap; warnings: string[] }
export const scoreSettingsSchema = z.object({
  bpm: z.number().min(20).max(400).nullable().default(null),
  numerator: z.number().int().min(1).max(12).nullable().default(null),
  denominator: z.union([z.literal(4), z.literal(8)]).default(4),
  firstDownbeat: z.number().min(0).max(1800).nullable().default(null),
  subdivision: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(6), z.literal(8)]).default(4),
  tunings: z.record(z.string(), z.enum(['guitar', 'drop-d', 'bass', 'bass-5'])).default({})
})
export type ScoreSettings = z.infer<typeof scoreSettingsSchema>
export const DEFAULT_SCORE_SETTINGS: ScoreSettings = scoreSettingsSchema.parse({})
export interface ScorePractice { rate: number; position: number; loop: { a: number; b: number } | null; tracks: Record<string, { mute: boolean; solo: boolean; volume: number }> }
export const scorePracticeSchema = z.object({ rate: z.number().min(.5).max(3), position: z.number().min(0).max(1800), loop: z.object({ a: z.number().min(0), b: z.number().max(1800) }).refine(v => v.b > v.a + .05).nullable(), tracks: z.record(z.string(), z.object({ mute: z.boolean(), solo: z.boolean(), volume: z.number().min(0).max(1) })) })
export interface ScoreSource { id: string; name: string; file: string; stemType?: string; duration: number; hash: string }
export interface ScoreProject {
  id: string; title: string; sourceSongId: string | null; sources: ScoreSource[]; model: ScoreModel;
  device: 'auto' | 'cpu' | 'cuda' | 'mps'; createdAt: string; updatedAt: string; openedAt: string | null;
  activeRun: string | null; settings: ScoreSettings; practice: ScorePractice; data: ScoreData | null;
  jobId: string | null; status: string; progress: number; phase: string; error: string | null
}
export interface ScoreRuntime { ready: boolean; busy: boolean; stage: string; progress: number | null; device: 'cpu' | 'cuda' | 'mps'; models: Record<ScoreModel, boolean>; soundfont: boolean; accepted: boolean; hasToken: boolean; error: string | null }
export const scoreCreateSchema = z.object({ songId: z.string().uuid().optional(), stemIds: z.array(z.string().uuid()).max(32).optional(), title: z.string().trim().min(1).max(200).optional() })
export interface ScoreApi {
  list(): Promise<ScoreProject[]>; get(id: string): Promise<ScoreProject | null>;
  create(input: z.infer<typeof scoreCreateSchema>): Promise<ScoreProject | null>;
  transcribe(id: string, model: ScoreModel, device?: ScoreProject['device']): Promise<string>;
  render(id: string, settings: ScoreSettings): Promise<string>;
  savePractice(id: string, practice: ScorePractice): Promise<void>;
  notation(id: string, trackIds: string[], tab: boolean, startBar: number): Promise<{ xml: string; startBeat: number; bars: number }>;
  export(id: string, trackIds: string[], format: 'midi' | 'musicxml', quantized: boolean, tab: boolean): Promise<string | null>;
  delete(id: string): Promise<void>; runtime(): Promise<ScoreRuntime>;
  prepare(input: { acceptLicense: boolean; token?: string; model: ScoreModel; importLocal?: boolean }): Promise<ScoreRuntime>;
  cancelPreparation(): Promise<void>; soundfont(): Promise<Uint8Array>;
  onChanged(callback: () => void): () => void
}

export function scoreTimeToBeat(tempo: TempoMap, time: number): number {
  const p = tempo.points
  if (p.length < 2) return (time - tempo.firstDownbeat) * tempo.bpm / 60
  let i = 0
  while (i + 2 < p.length && p[i + 1]!.time <= time) i++
  const a = p[i]!, b = p[i + 1]!
  return a.beat + (time - a.time) * (b.beat - a.beat) / (b.time - a.time)
}

/** Playback-only MIDI: absolute seconds at 120 BPM. Export preserves the real tempo map. */
export function scorePlaybackMidi(data: ScoreData, from = 0, to = data.duration): { bytes: Uint8Array; channels: number[] } {
  const word = (n: number) => [n >> 8 & 255, n & 255]
  const dword = (n: number) => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255]
  const variable = (n: number): number[] => { const a = [n & 127]; while ((n >>>= 7) > 0) a.unshift((n & 127) | 128); return a }
  const chunk = (type: string, b: number[]) => [...Array.from(type, c => c.charCodeAt(0)), ...dword(b.length), ...b]
  const channels: number[] = []; let melodic = 0, drumPort = 0
  const tracks = data.tracks.map(track => {
    const slot = track.isDrum ? (drumPort++ * 16 + 9) : (() => { const port = Math.floor(melodic / 15); const c = melodic++ % 15; return port * 16 + (c >= 9 ? c + 1 : c) })()
    channels.push(slot)
    const port = Math.floor(slot / 16), channel = slot % 16
    const name = [...new TextEncoder().encode(track.name)]
    const events: { at: number; order: number; message: number[] }[] = []
    for (const n of track.notes) {
      if (n.end <= from || n.start >= to) continue
      events.push({ at: Math.round((Math.max(from, n.start) - from) * 960), order: 1, message: [0x90 | channel, n.pitch, n.velocity] })
      events.push({ at: Math.max(1, Math.round((Math.min(to, n.end) - from) * 960)), order: 0, message: [0x80 | channel, n.pitch, 0] })
    }
    const body = [0, 255, 33, 1, port, 0, 255, 3, ...variable(name.length), ...name, 0, 0xc0 | channel, track.program]
    let previous = 0
    for (const event of events.sort((a, b) => a.at - b.at || a.order - b.order)) { body.push(...variable(event.at - previous), ...event.message); previous = event.at }
    body.push(...variable(Math.max(0, Math.round((to - from) * 960) - previous)), 255, 47, 0)
    return chunk('MTrk', body)
  })
  const header = chunk('MThd', [...word(1), ...word(tracks.length + 1), ...word(480)])
  // Explicit markers preserve leading/trailing silence and the exact AB interval.
  // SpessaSynth otherwise derives duration and loop start from voice events.
  const meta = chunk('MTrk', [0, 255, 81, 3, 7, 161, 32,
    0, 255, 6, 9, ...new TextEncoder().encode('loopStart'),
    ...variable(Math.round((to - from) * 960)), 255, 6, 7, ...new TextEncoder().encode('loopEnd'), 0, 255, 47, 0])
  return { bytes: new Uint8Array([...header, ...meta, ...tracks.flat()]), channels }
}
