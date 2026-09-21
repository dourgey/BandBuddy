import type { LyricsDocument, StemType } from './domain.js'

export interface LanAsset { url: string; bytes: number; sha256: string; mimeType: string }
export interface LanSongSummary {
  id: string; title: string; artist: string; durationMs: number; updatedAt: string; stemCount: number; manifest: string
}
export interface LanSong {
  version: 1
  id: string; title: string; artist: string; durationMs: number; updatedAt: string
  lyrics: LyricsDocument | null; bpm: number | null; musicalKey: string | null
  stems: Array<{ id: string; type: StemType; name: string; durationMs: number; sampleRate: number; channels: number; defaultVisible: boolean; audio: LanAsset; peaks: LanAsset | null }>
  artwork: LanAsset | null; video: LanAsset | null
}
