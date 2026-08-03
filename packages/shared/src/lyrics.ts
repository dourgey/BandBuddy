import type { LyricCue, LyricsDocument } from './domain.js'

const METADATA_PATTERN = /^\[(ar|ti|al):([^\]]*)\]\s*$/i
const OFFSET_PATTERN = /^\s*\[offset:([+-]?\d+)\]\s*$/im
const TIMESTAMP_PATTERN = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g
const ENHANCED_TIMESTAMP_PATTERN = /<\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?>/g

export interface LyricFrame {
  current: LyricCue | null
  next: LyricCue | null
  progress: number
}

function fractionToMilliseconds(value: string | undefined): number {
  if (!value) return 0
  if (value.length === 1) return Number(value) * 100
  if (value.length === 2) return Number(value) * 10
  return Number(value.slice(0, 3))
}

export function parseLrc(source: string, fileName = 'lyrics.lrc'): LyricsDocument {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const offsetMatch = OFFSET_PATTERN.exec(normalized)
  const offsetMs = offsetMatch ? Number(offsetMatch[1]) : 0
  const metadata: Record<'ar' | 'ti' | 'al', string | null> = { ar: null, ti: null, al: null }
  const cueMap = new Map<number, string[]>()

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    const metadataMatch = METADATA_PATTERN.exec(line)
    if (metadataMatch) {
      const key = metadataMatch[1]!.toLowerCase() as keyof typeof metadata
      metadata[key] = metadataMatch[2]!.trim() || null
      continue
    }

    const timestamps = [...line.matchAll(TIMESTAMP_PATTERN)]
    if (timestamps.length === 0) continue
    const text = line
      .replace(TIMESTAMP_PATTERN, '')
      .replace(ENHANCED_TIMESTAMP_PATTERN, '')
      .trim()
    if (!text) continue

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1])
      const seconds = Number(timestamp[2])
      const timeMs = Math.max(0, minutes * 60_000 + seconds * 1000 + fractionToMilliseconds(timestamp[3]) + offsetMs)
      const lines = cueMap.get(timeMs) ?? []
      if (!lines.includes(text)) lines.push(text)
      cueMap.set(timeMs, lines)
    }
  }

  const cues = [...cueMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timeMs, lines]) => ({ timeMs, lines }))

  return {
    fileName,
    title: metadata.ti,
    artist: metadata.ar,
    album: metadata.al,
    cues
  }
}

export function lyricFrameAt(cues: readonly LyricCue[], currentMs: number): LyricFrame {
  if (cues.length === 0) return { current: null, next: null, progress: 0 }
  const position = Math.max(0, Number.isFinite(currentMs) ? currentMs : 0)
  let low = 0
  let high = cues.length - 1
  let currentIndex = -1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const cue = cues[middle]!
    if (cue.timeMs <= position) {
      currentIndex = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (currentIndex < 0) return { current: null, next: cues[0]!, progress: 0 }
  const current = cues[currentIndex]!
  const next = cues[currentIndex + 1] ?? null
  const duration = next ? next.timeMs - current.timeMs : 0
  const progress = next && duration > 0
    ? Math.min(1, Math.max(0, (position - current.timeMs) / duration))
    : 1
  return { current, next, progress }
}
