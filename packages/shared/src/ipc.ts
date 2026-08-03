import { z } from 'zod'
import {
  METRONOME_OFFSET_MAX_MS,
  METRONOME_OFFSET_MIN_MS,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  STEM_ORDER,
  isTrackOrderKey,
  stemTrackOrderKey,
  type TrackOrderKey
} from './domain.js'
import {
  REHEARSAL_TRANSITION_MAX_MS,
  REHEARSAL_TRANSITION_MIN_MS
} from './rehearsal.js'
export { IPC } from './channels.js'

export const stemTypeSchema = z.enum(STEM_ORDER)
export const computeDeviceSchema = z.enum(['auto', 'cuda', 'mps', 'cpu'])
export const exportFormatSchema = z.enum(['wav', 'flac', 'mp3'])
export const audioBackendSchema = z.enum(['auto', 'asio', 'wasapi-exclusive', 'wasapi-shared', 'coreaudio'])

export const recordingAudioSettingsSchema = z.object({
  backend: audioBackendSchema,
  inputDeviceId: z.string().max(500),
  outputDeviceId: z.string().max(500),
  inputChannelMode: z.enum(['mono', 'stereo']),
  inputChannels: z.array(z.number().int().min(0).max(255)).min(1).max(2),
  sampleRate: z.union([z.literal(0), z.number().int().min(8000).max(384000)]),
  bufferFrames: z.union([z.literal(0), z.number().int().min(16).max(8192)]),
  alignmentOffsetMs: z.number().min(-1000).max(1000),
  deviceAlignmentOffsets: z.record(z.string().max(1200), z.number().min(-1000).max(1000)).default({})
}).refine((value) => value.inputChannels.length === (value.inputChannelMode === 'mono' ? 1 : 2), '输入声道数量与模式不匹配')

export const importSourceSchema = z.object({
  filePath: z.string().min(1).optional(),
  title: z.string().trim().max(200).optional(),
  artist: z.string().trim().max(200).optional(),
  forceDuplicate: z.boolean().optional()
})

export const existingStemInputSchema = z.object({
  path: z.string().min(1),
  type: stemTypeSchema
})

export const importStemsSchema = z.object({
  files: z.array(existingStemInputSchema).min(2).max(6).optional(),
  folderPath: z.string().min(1).optional(),
  title: z.string().trim().max(200).optional(),
  artist: z.string().trim().max(200).optional(),
  padMismatched: z.boolean().optional()
}).refine((value) => Boolean(value.files?.length || value.folderPath), '需要选择分轨文件或文件夹')

export const updateSongSchema = z.object({
  id: z.string().uuid(),
  patch: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    artist: z.string().trim().max(200).optional(),
    favorite: z.boolean().optional(),
    bpm: z.number().min(20).max(400).nullable().optional(),
    beatOffsetMs: z.number().min(METRONOME_OFFSET_MIN_MS).max(METRONOME_OFFSET_MAX_MS).optional(),
    musicalKey: z.string().trim().max(16).nullable().optional(),
    timeSignature: z.string().trim().regex(/^\d{1,2}\/\d{1,2}$/).nullable().optional()
  })
})

export const trackStateSchema = z.object({
  stemType: stemTypeSchema,
  gainDb: z.number().min(-60).max(6),
  muted: z.boolean(),
  solo: z.boolean()
})

const trackOrderKeySchema = z.custom<TrackOrderKey>(isTrackOrderKey, '无效的轨道顺序标识')

export const practiceStateSchema = z.object({
  songId: z.string().uuid(),
  positionMs: z.number().nonnegative(),
  playbackRate: z.number().min(PLAYBACK_RATE_MIN).max(PLAYBACK_RATE_MAX),
  masterGainDb: z.number().min(-60).max(6),
  metronomeEnabled: z.boolean(),
  metronomeBpm: z.number().min(20).max(400),
  metronomeOffsetMs: z.number().min(METRONOME_OFFSET_MIN_MS).max(METRONOME_OFFSET_MAX_MS),
  desktopLyricsEnabled: z.boolean(),
  countInBeats: z.union([z.literal(0), z.literal(4), z.literal(8)]),
  loopStartMs: z.number().nonnegative().nullable(),
  loopEndMs: z.number().nonnegative().nullable(),
  loopEnabled: z.boolean(),
  zoom: z.number().min(1).max(100),
  scroll: z.number().nonnegative(),
  selectedStem: stemTypeSchema.nullable(),
  tracks: z.array(trackStateSchema).length(6),
  trackOrder: z.array(trackOrderKeySchema).min(STEM_ORDER.length),
  updatedAt: z.string()
}).refine((value) => new Set(value.tracks.map((track) => track.stemType)).size === STEM_ORDER.length, {
  message: '练习状态必须包含六条唯一音轨'
}).refine((value) => new Set(value.trackOrder).size === value.trackOrder.length, {
  message: '轨道顺序不能包含重复项'
}).refine((value) => STEM_ORDER.every((stemType) => value.trackOrder.includes(stemTrackOrderKey(stemType))), {
  message: '轨道顺序必须包含六条分轨'
}).refine((value) => value.loopStartMs === null || value.loopEndMs === null || value.loopEndMs > value.loopStartMs, {
  message: 'B 点必须晚于 A 点'
})

export const exportRequestSchema = z.object({
  songId: z.string().uuid(),
  kind: z.enum(['stems', 'mix']),
  format: exportFormatSchema,
  stemTypes: z.array(stemTypeSchema).min(1).max(6),
  outputPath: z.string().min(1).optional(),
  applyPlaybackRate: z.boolean(),
  playbackRate: z.number().min(PLAYBACK_RATE_MIN).max(PLAYBACK_RATE_MAX),
  applyLoopRange: z.boolean(),
  loopStartMs: z.number().nonnegative().nullable(),
  loopEndMs: z.number().nonnegative().nullable(),
  overwriteMode: z.enum(['ask', 'overwrite', 'rename']),
  includeActiveTake: z.boolean().default(false)
}).refine((value) => new Set(value.stemTypes).size === value.stemTypes.length, '导出音轨不能重复')
  .refine((value) => !value.applyLoopRange || (value.loopStartMs !== null && value.loopEndMs !== null && value.loopEndMs > value.loopStartMs), 'A–B 导出范围无效')

export const listSongsSchema = z.object({
  query: z.string().max(200).default(''),
  filter: z.enum(['all', 'favorite', 'processing', 'recent']).default('all')
})

export const uuidSchema = z.string().uuid()

export const desktopLyricsPayloadSchema = z.object({
  title: z.string().max(200),
  artist: z.string().max(200),
  currentLines: z.array(z.string().max(1000)).max(4),
  nextLines: z.array(z.string().max(1000)).max(4),
  progress: z.number().min(0).max(1),
  playing: z.boolean()
})

const httpsUrlSchema = z.string().url().max(2000).refine((value) => new URL(value).protocol === 'https:', '必须使用 HTTPS')

export const networkSettingsSchema = z.object({
  proxyMode: z.enum(['system', 'manual', 'none']),
  proxyUrl: z.string().max(2000),
  pythonInstallMirror: z.union([z.literal(''), httpsUrlSchema]),
  pythonIndexUrl: httpsUrlSchema,
  pytorchIndexUrl: z.union([z.literal(''), httpsUrlSchema]),
  modelBaseUrl: httpsUrlSchema
})

export const appSettingsSchema = z.object({
  libraryRoot: z.string().min(3).max(1000),
  runtimeRoot: z.string().min(3).max(1000),
  modelRoot: z.string().min(3).max(1000),
  preferredDevice: computeDeviceSchema,
  audioOutputDeviceId: z.string().max(500),
  latencyMode: z.enum(['interactive', 'balanced', 'playback']),
  recordingAudio: recordingAudioSettingsSchema,
  keepSource: z.boolean(),
  closeToTrayWhileWorking: z.boolean(),
  network: networkSettingsSchema
})

export const recordingStartSchema = z.object({
  songId: z.string().uuid(),
  recordingTrackId: z.string().uuid(),
  positionMs: z.number().nonnegative(),
  practice: practiceStateSchema
}).refine((value) => value.songId === value.practice.songId, '歌曲与练习状态不匹配')

export const recordingTrackUpdateSchema = z.object({
  recordingTrackId: z.string().uuid(),
  patch: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    gainDb: z.number().min(-60).max(6).optional(),
    muted: z.boolean().optional(),
    solo: z.boolean().optional()
  }).refine((value) => Object.keys(value).length > 0, 'RECORDING_TRACK_PATCH_EMPTY')
})

export const recordingTakeUpdateSchema = z.object({
  takeId: z.string().uuid(),
  name: z.string().trim().min(1).max(100).optional(),
  alignmentOffsetMs: z.number().min(-1000).max(1000).optional()
}).refine((value) => value.name !== undefined || value.alignmentOffsetMs !== undefined, '没有需要更新的字段')

export const rehearsalItemSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().uuid(),
    kind: z.literal('song'),
    songId: z.string().uuid().nullable(),
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().max(200),
    durationMs: z.number().int().nonnegative(),
    artworkUrl: z.string().max(2000).nullable(),
    available: z.boolean()
  }),
  z.object({
    id: z.string().uuid(),
    kind: z.literal('transition'),
    durationMs: z.number().int().min(REHEARSAL_TRANSITION_MIN_MS).max(REHEARSAL_TRANSITION_MAX_MS)
  })
])

export const rehearsalSaveSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  items: z.array(rehearsalItemSchema).max(500)
}).refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, '编排项目不能重复')

export const rehearsalDuplicateSchema = z.object({
  rehearsalId: z.string().uuid(),
  revisionId: z.string().uuid().optional()
})

export const rehearsalRecordingStartSchema = z.object({
  rehearsalId: z.string().uuid(),
  recordingTrackId: z.string().uuid(),
  positionMs: z.number().nonnegative()
})

export const rehearsalRecordingTrackUpdateSchema = z.object({
  recordingTrackId: z.string().uuid(),
  patch: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    gainDb: z.number().min(-60).max(6).optional(),
    muted: z.boolean().optional(),
    solo: z.boolean().optional()
  }).refine((value) => Object.keys(value).length > 0, 'REHEARSAL_RECORDING_TRACK_PATCH_EMPTY')
})
