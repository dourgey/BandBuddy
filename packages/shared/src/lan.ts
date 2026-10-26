import type { LyricsDocument, StemType } from './domain.js'

export const LAN_PCM_RATE = 48000
export const LAN_PCM_FRAMES = 960
export const LAN_PCM_HEADER = 40
export const LAN_PCM_MAGIC = 0x314d4350 // PCM1, little endian
export interface LanMixState { gain: number; muted: boolean; solo: boolean; visible?: boolean }
export interface LanPcmConfig {
  type: 'configure'; generation: number; songId: string; position: number
  rate: number; pitch: number; playing: boolean; mix: LanMixState[]
  loop: { start: number; end: number } | null
}
export type LanPcmCommand = LanPcmConfig | { type: 'pull'; generation: number; count: number }
  | { type: 'mix'; generation: number; mix: LanMixState[] }
export type LanPcmEvent = { type: 'ready'; generation: number } | { type: 'ended'; generation: number }
  | { type: 'error'; generation: number; message: string }

export interface LanAsset { url: string; bytes: number; sha256: string; mimeType: string }
export interface LanSongSummary {
  id: string; title: string; artist: string; durationMs: number; updatedAt: string; stemCount: number; manifest: string
}
export interface LanSong {
  version: 1 | 2
  stemGroups?: Array<{ parent: StemType; children: readonly StemType[]; splitEnabled: boolean; available: boolean }>
  id: string; title: string; artist: string; durationMs: number; updatedAt: string
  lyrics: LyricsDocument | null; bpm: number | null; musicalKey: string | null
  stems: Array<{ id: string; type: StemType; name: string; durationMs: number; sampleRate: number; channels: number; numFrames?: number; encodingGain?: number; defaultVisible: boolean; audio: LanAsset; peaks: LanAsset | null }>
  artwork: LanAsset | null; video: LanAsset | null
}
