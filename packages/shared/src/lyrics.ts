import { DOMParser } from '@xmldom/xmldom'
import type { LyricWord, LyricCue, LyricsDocument } from './domain.js'

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
  const words = new Map<number, Map<string, LyricWord[]>>()

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    const metadataMatch = METADATA_PATTERN.exec(line)
    if (metadataMatch) {
      const key = metadataMatch[1]!.toLowerCase() as keyof typeof metadata
      metadata[key] = metadataMatch[2]!.trim() || null
      continue
    }

    const header = /^(?:\[\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?\])+/.exec(line)?.[0] ?? ''
    const timestamps = [...header.matchAll(TIMESTAMP_PATTERN)]
    if (timestamps.length === 0) continue
    const body = line.slice(header.length)
    const timedBody = /[<\[]\d{1,3}:/.test(body) && !/^[<\[]/.test(body) ? `<${timestamps[0]![0].slice(1, -1)}>${body}` : body
    const markers = [...timedBody.matchAll(/<(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?>|\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g)]
    const text = body
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
      if (markers.length > 1) {
        const base = Number(timestamps[0]![1]) * 60000 + Number(timestamps[0]![2]) * 1000 + fractionToMilliseconds(timestamps[0]![3]) + offsetMs
        const timings = markers.map(m => Number(m[1] ?? m[4]) * 60000 + Number(m[2] ?? m[5]) * 1000 + fractionToMilliseconds(m[3] ?? m[6]) + offsetMs + timeMs - base)
        const wordLine = markers.flatMap((m, i) => {
          const text = timedBody.slice(m.index! + m[0].length, markers[i + 1]?.index ?? timedBody.length)
          return text ? [{ text, timeMs: Math.max(0, timings[i]!), endMs: Math.max(0, timings[i + 1] ?? timings[i]!) }] : []
        })
        if (wordLine.length) {
          const timedLines = words.get(timeMs) ?? new Map<string, LyricWord[]>()
          timedLines.set(text, wordLine)
          words.set(timeMs, timedLines)
        }
      }
    }
  }

  const cues = [...cueMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timeMs, lines]) => ({ timeMs, lines, ...(words.has(timeMs) ? {
      wordLines: lines.map(text => words.get(timeMs)!.get(text) ?? [{ text, timeMs, endMs: timeMs }])
    } : {}) }))
  for (let i = 0; i < cues.length; i++) {
    for (const line of cues[i]!.wordLines ?? []) {
      for (const word of line) {
        if (word.endMs <= word.timeMs) word.endMs = cues[i + 1]?.timeMs ?? word.timeMs + 2000
      }
    }
  }

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
  if (current.endMs !== undefined && position >= current.endMs) return { current: null, next, progress: 0 }
  const end = current.endMs ?? next?.timeMs
  const duration = end !== undefined ? end - current.timeMs : 0
  const progress = duration > 0
    ? Math.min(1, Math.max(0, (position - current.timeMs) / duration))
    : 1
  return { current, next, progress }
}

function xml(source: string): ReturnType<DOMParser['parseFromString']> {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('INVALID_LYRICS_XML')
  return new DOMParser({ onError: () => { throw new Error('INVALID_LYRICS_XML') } }).parseFromString(source, 'text/xml')
}

function time(value: string | null, frameRate = 30, tickRate = 1): number {
  if (!value) return 0
  const offset = /^((?:\d+(?:\.\d+)?|\.\d+))(ms|s|m|h|f|t)$/.exec(value)
  if (offset) return Number(offset[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, f: 1000 / frameRate, t: 1000 / tickRate }[offset[2]!] ?? 1)
  const parts = value.replace(',', '.').split(':').map(Number)
  if (parts.some(n => !Number.isFinite(n))) throw new Error('INVALID_LYRICS_TIME')
  if (parts.length === 4) return parts[0]! * 3600000 + parts[1]! * 60000 + parts[2]! * 1000 + parts[3]! * 1000 / frameRate
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000
}

function documentFor(fileName: string, cues: LyricCue[]): LyricsDocument {
  return { fileName, title: null, artist: null, album: null, cues: cues.filter(c => c.lines.some(Boolean)).sort((a, b) => a.timeMs - b.timeMs) }
}

/** Parse decoded lyric text. Binary KRC/QRC decoding is confined to the main process. */
export function parseLyrics(source: string, fileName = 'lyrics.lrc'): LyricsDocument {
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'lrc') return parseLrc(source, fileName)
  if (ext === 'krc' || ext === 'qrc') {
    if (ext === 'qrc' && /^\s*</.test(source)) {
      const doc = xml(source)
      const nodes = Array.from(doc.getElementsByTagName('*'))
      source = nodes.find(n => n.hasAttribute('LyricContent'))?.getAttribute('LyricContent') ?? source
    }
    const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(source)?.[1] ?? 0)
    const cues: LyricCue[] = []
    for (const raw of source.split('\n')) {
      const header = /^\s*\[(\d+),(\d+)\]/.exec(raw)
      if (!header) continue
      const start = Number(header[1]) + offset, duration = Number(header[2])
      const body = raw.slice(header[0].length)
      const words: LyricWord[] = []
      if (ext === 'krc') {
        for (const m of body.matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)) words.push({ text: m[3]!, timeMs: start + Number(m[1]), endMs: start + Number(m[1]) + Number(m[2]) })
      } else {
        for (const m of body.matchAll(/([^()]+)\((\d+),(\d+)\)/g)) words.push({ text: m[1]!, timeMs: Number(m[2]) + offset, endMs: Number(m[2]) + offset + Number(m[3]) })
      }
      if (words.length) cues.push({ timeMs: Math.max(0, start), endMs: Math.max(0, start + duration), lines: [words.map(w => w.text).join('')], wordLines: [words] })
    }
    return documentFor(fileName, cues)
  }
  if (ext === 'srt' || ext === 'vtt') {
    const cues: LyricCue[] = []
    for (const block of source.trim().split(/\n\s*\n/)) {
      const lines = block.split('\n')
      if (/^(NOTE|STYLE|REGION)\b/.test(lines[0] ?? '')) continue
      const index = lines.findIndex(l => l.includes('-->'))
      if (index < 0) continue
      const match = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[index]!)
      if (!match) continue
      const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '')
      const decoded = xml(`<text>${text.replace(/&(?!#\d+;|#x[\da-f]+;|amp;|lt;|gt;|quot;|apos;)/gi, '&amp;')}</text>`).documentElement!.textContent ?? ''
      const start = time(match[1]!), end = time(match[2]!)
      if (end > start) cues.push({ timeMs: start, endMs: end, lines: decoded.split('\n') })
    }
    return documentFor(fileName, cues)
  }
  if (ext === 'ttml') {
    const doc = xml(source), root = doc.documentElement!
    const frameRate = Number(root.getAttribute('ttp:frameRate') || 30), tickRate = Number(root.getAttribute('ttp:tickRate') || 1)
    const clock = (v: string | null): number => time(v, frameRate, tickRate)
    const cues: LyricCue[] = []
    const absoluteSpans = Boolean(root.getAttribute('xmlns:amll'))
    type Element = typeof root
    const walk = (element: Element, parentStart: number, parentEnd: number): void => {
      const start = parentStart + clock(element.getAttribute('begin'))
      const end = Math.min(parentEnd, element.hasAttribute('end') ? parentStart + clock(element.getAttribute('end')) : Infinity, element.hasAttribute('dur') ? start + clock(element.getAttribute('dur')) : Infinity)
      if (element.localName === 'p') {
        const words: LyricWord[] = []
        const secondary: string[] = []
        const collect = (node: typeof element, base: number, limit: number): void => {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 3 || child.nodeType === 4) { if (child.nodeValue) words.push({ text: child.nodeValue.replace(/\s+/g, ' '), timeMs: base, endMs: limit }) }
            else if (child.nodeType === 1) {
              const e = child as Element
              if (e.localName === 'br') { words.push({ text: '\n', timeMs: base, endMs: limit }); continue }
              if (/translation|roman/i.test(e.getAttribute('ttm:role') ?? '')) { secondary.push(e.textContent ?? ''); continue }
              const t = e.getAttribute('begin')
              const timeBase = absoluteSpans && t?.includes(':') ? 0 : base
              const nextStart = timeBase + clock(t)
              const nextEnd = Math.min(limit, e.hasAttribute('end') ? timeBase + clock(e.getAttribute('end')) : Infinity, e.hasAttribute('dur') ? nextStart + clock(e.getAttribute('dur')) : Infinity)
              collect(e, nextStart, nextEnd)
            }
          }
        }
        collect(element, start, end)
        const text = words.map(w => w.text).join('').trim()
        if (text && Number.isFinite(start)) {
          const timedLines: LyricWord[][] = [[]]
          for (const word of words) {
            const fragments = word.text.split('\n')
            fragments.forEach((fragment, index) => {
              if (index) timedLines.push([])
              if (fragment) timedLines.at(-1)!.push({ ...word, text: fragment, endMs: Number.isFinite(word.endMs) ? word.endMs : word.timeMs + 2000 })
            })
          }
          cues.push({
            timeMs: start,
            ...(Number.isFinite(end) ? { endMs: end } : {}),
            lines: [...text.split('\n'), ...secondary],
            wordLines: [...timedLines, ...secondary.map(text => [{ text, timeMs: start, endMs: Number.isFinite(end) ? end : start + 2000 }])]
          })
        }
      } else for (const child of Array.from(element.childNodes)) if (child.nodeType === 1) walk(child as Element, start, end)
    }
    walk(root, 0, Infinity)
    return documentFor(fileName, cues)
  }
  throw new Error('UNSUPPORTED_LYRICS_FORMAT')
}

export function lyricWordFrame(cue: LyricCue | null, currentMs: number): Array<Array<{ text: string; progress: number }>> | undefined {
  return cue?.wordLines?.slice(0, 4).map(line => {
    let remaining = 1000
    return line.slice(0, 1000).flatMap(word => {
      const text = word.text.slice(0, remaining)
      remaining -= text.length
      return text ? [{ text, progress: Math.max(0, Math.min(1, (currentMs - word.timeMs) / Math.max(1, word.endMs - word.timeMs))) }] : []
    })
  })
}
