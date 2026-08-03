import type {
  PracticeState,
  RecordingDeviceSnapshot,
  RecordingPhase,
  RecordingState,
  SongDetail
} from './domain.js'

export const REHEARSAL_TRANSITION_DEFAULT_MS = 10_000
export const REHEARSAL_TRANSITION_MIN_MS = 1_000
export const REHEARSAL_TRANSITION_MAX_MS = 3_600_000

export interface RehearsalSongItem {
  id: string
  kind: 'song'
  songId: string | null
  title: string
  artist: string
  durationMs: number
  artworkUrl: string | null
  available: boolean
}

export interface RehearsalTransitionItem {
  id: string
  kind: 'transition'
  durationMs: number
}

export type RehearsalItem = RehearsalSongItem | RehearsalTransitionItem

export interface RehearsalSetSummary {
  id: string
  name: string
  itemCount: number
  songCount: number
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

export interface RehearsalRevisionSongSnapshot {
  itemId: string
  songId: string
  title: string
  artist: string
  durationMs: number
  practice: PracticeState
}

export interface RehearsalRevisionSnapshot {
  name: string
  items: RehearsalItem[]
  songs: RehearsalRevisionSongSnapshot[]
  totalDurationMs: number
}

export interface RehearsalRevision {
  id: string
  rehearsalId: string
  fingerprint: string
  snapshot: RehearsalRevisionSnapshot
  createdAt: string
}

export interface RehearsalRecordingTrackState {
  id: string
  rehearsalId: string
  name: string
  activeTakeId: string | null
  gainDb: number
  muted: boolean
  solo: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface RehearsalRecordingTake {
  id: string
  rehearsalId: string
  recordingTrackId: string
  revisionId: string
  timelineFingerprint: string
  name: string
  durationMs: number
  startPositionMs: number
  endPositionMs: number
  sampleRate: number
  channels: number
  alignmentOffsetMs: number
  inputDeviceName: string
  inputChannels: number[]
  deviceSnapshot: RecordingDeviceSnapshot
  sourceMediaUrl: string
  previewMediaUrl: string
  interrupted: boolean
  createdAt: string
}

export interface RehearsalSetDetail extends RehearsalSetSummary {
  items: RehearsalItem[]
  recordingTracks: RehearsalRecordingTrackState[]
  recordingTakes: RehearsalRecordingTake[]
  revisions: RehearsalRevision[]
}

export interface RehearsalTimelineSegment {
  id: string
  itemId: string
  kind: 'countIn' | 'song' | 'transition'
  startMs: number
  endMs: number
  songId: string | null
  title: string
  artist: string
  sourceDurationMs: number
  playbackRate: number
  metronomeBpm: number
  metronomeOffsetMs: number
  metronomeEnabled: boolean
  desktopLyricsEnabled: boolean
  countInBeats: 0 | 4 | 8
}

export interface RehearsalTimeline {
  segments: RehearsalTimelineSegment[]
  totalDurationMs: number
  fingerprint: string
  unavailableItemIds: string[]
}

export interface RehearsalTimelinePosition {
  segment: RehearsalTimelineSegment | null
  globalMs: number
  segmentMs: number
  songSourceMs: number
}

export interface RehearsalRecordingState {
  target: 'rehearsal'
  phase: RecordingPhase | 'paused'
  sessionId: string | null
  rehearsalId: string | null
  recordingTrackId: string | null
  revisionId: string | null
  timelineFingerprint: string | null
  timelinePositionMs: number
  preRollRemaining: number
  sampleRate: number
  bufferFrames: number
  latencyMs: number
  xruns: number
  splitDevices: boolean
  message: string
  error: string | null
}

export type TargetedRecordingState = RecordingState | RehearsalRecordingState

export interface RehearsalRecordingStartRequest {
  rehearsalId: string
  recordingTrackId: string
  positionMs: number
}

export interface SaveRehearsalRequest {
  id: string
  name: string
  items: RehearsalItem[]
}

export function buildRehearsalTimeline(
  items: readonly RehearsalItem[],
  songs: readonly SongDetail[]
): RehearsalTimeline {
  const byId = new Map(songs.map((song) => [song.id, song]))
  const segments: RehearsalTimelineSegment[] = []
  const unavailableItemIds: string[] = []
  const fingerprintParts: Array<Record<string, unknown>> = []
  let cursor = 0

  for (const item of items) {
    if (item.kind === 'transition') {
      const durationMs = clampTransitionDuration(item.durationMs)
      segments.push({
        id: `${item.id}:transition`,
        itemId: item.id,
        kind: 'transition',
        startMs: cursor,
        endMs: cursor + durationMs,
        songId: null,
        title: '空白衔接',
        artist: '',
        sourceDurationMs: durationMs,
        playbackRate: 1,
        metronomeBpm: 120,
        metronomeOffsetMs: 0,
        metronomeEnabled: false,
        desktopLyricsEnabled: false,
        countInBeats: 0
      })
      cursor += durationMs
      fingerprintParts.push({ itemId: item.id, kind: item.kind, durationMs })
      continue
    }

    const song = item.songId ? byId.get(item.songId) : undefined
    if (!song || song.status !== 'ready' || !song.stems.length) {
      unavailableItemIds.push(item.id)
      fingerprintParts.push({ itemId: item.id, kind: item.kind, songId: item.songId, unavailable: true })
      continue
    }

    const practice = song.practice
    const playbackRate = Number.isFinite(practice.playbackRate) && practice.playbackRate > 0
      ? practice.playbackRate
      : 1
    const countInBeats = practice.countInBeats
    const countInDurationMs = countInBeats > 0
      ? countInBeats * 60_000 / practice.metronomeBpm / playbackRate
      : 0
    if (countInDurationMs > 0) {
      segments.push({
        id: `${item.id}:count-in`,
        itemId: item.id,
        kind: 'countIn',
        startMs: cursor,
        endMs: cursor + countInDurationMs,
        songId: song.id,
        title: song.title,
        artist: song.artist,
        sourceDurationMs: song.durationMs,
        playbackRate,
        metronomeBpm: practice.metronomeBpm,
        metronomeOffsetMs: practice.metronomeOffsetMs,
        metronomeEnabled: practice.metronomeEnabled,
        desktopLyricsEnabled: practice.desktopLyricsEnabled,
        countInBeats
      })
      cursor += countInDurationMs
    }

    const songDurationMs = song.durationMs / playbackRate
    segments.push({
      id: `${item.id}:song`,
      itemId: item.id,
      kind: 'song',
      startMs: cursor,
      endMs: cursor + songDurationMs,
      songId: song.id,
      title: song.title,
      artist: song.artist,
      sourceDurationMs: song.durationMs,
      playbackRate,
      metronomeBpm: practice.metronomeBpm,
      metronomeOffsetMs: practice.metronomeOffsetMs,
      metronomeEnabled: practice.metronomeEnabled,
      desktopLyricsEnabled: practice.desktopLyricsEnabled,
      countInBeats
    })
    cursor += songDurationMs
    fingerprintParts.push({
      itemId: item.id,
      kind: item.kind,
      songId: song.id,
      durationMs: song.durationMs,
      playbackRate: roundFingerprintNumber(playbackRate),
      countInBeats,
      countInBpm: countInBeats > 0 ? roundFingerprintNumber(practice.metronomeBpm) : null
    })
  }

  return {
    segments,
    totalDurationMs: cursor,
    fingerprint: stableFingerprint(fingerprintParts),
    unavailableItemIds
  }
}

export function rehearsalTimelinePosition(
  timeline: RehearsalTimeline,
  positionMs: number
): RehearsalTimelinePosition {
  const globalMs = Math.max(0, Math.min(positionMs, timeline.totalDurationMs))
  const segment = timeline.segments.find((candidate) => globalMs >= candidate.startMs && globalMs < candidate.endMs)
    ?? (globalMs === timeline.totalDurationMs ? timeline.segments.at(-1) ?? null : null)
  if (!segment) return { segment: null, globalMs, segmentMs: 0, songSourceMs: 0 }
  const segmentMs = globalMs === timeline.totalDurationMs
    ? segment.endMs - segment.startMs
    : Math.max(0, globalMs - segment.startMs)
  return {
    segment,
    globalMs,
    segmentMs,
    songSourceMs: segment.kind === 'song'
      ? Math.min(segment.sourceDurationMs, segmentMs * segment.playbackRate)
      : 0
  }
}

export function createRehearsalRevisionSnapshot(
  rehearsal: Pick<RehearsalSetDetail, 'name' | 'items'>,
  songs: readonly SongDetail[],
  timeline: RehearsalTimeline
): RehearsalRevisionSnapshot {
  const byId = new Map(songs.map((song) => [song.id, song]))
  return {
    name: rehearsal.name,
    items: rehearsal.items.map((item) => ({ ...item })),
    songs: rehearsal.items.flatMap((item) => {
      if (item.kind !== 'song' || !item.songId) return []
      const song = byId.get(item.songId)
      return song ? [{
        itemId: item.id,
        songId: song.id,
        title: song.title,
        artist: song.artist,
        durationMs: song.durationMs,
        practice: structuredClone(song.practice)
      }] : []
    }),
    totalDurationMs: timeline.totalDurationMs
  }
}

export function clampTransitionDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return REHEARSAL_TRANSITION_DEFAULT_MS
  return Math.round(Math.max(REHEARSAL_TRANSITION_MIN_MS, Math.min(REHEARSAL_TRANSITION_MAX_MS, durationMs)) / 1000) * 1000
}

function stableFingerprint(value: unknown): string {
  const source = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function roundFingerprintNumber(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
