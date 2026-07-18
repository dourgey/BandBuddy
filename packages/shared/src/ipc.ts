import { z } from 'zod'
import { METRONOME_OFFSET_MAX_MS, METRONOME_OFFSET_MIN_MS, PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN, STEM_ORDER } from './domain.js'
export { IPC } from './channels.js'

export const stemTypeSchema = z.enum(STEM_ORDER)
export const computeDeviceSchema = z.enum(['auto', 'cuda', 'mps', 'cpu'])
export const exportFormatSchema = z.enum(['wav', 'flac', 'mp3'])

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

export const practiceStateSchema = z.object({
  songId: z.string().uuid(),
  positionMs: z.number().nonnegative(),
  playbackRate: z.number().min(PLAYBACK_RATE_MIN).max(PLAYBACK_RATE_MAX),
  masterGainDb: z.number().min(-60).max(6),
  metronomeEnabled: z.boolean(),
  metronomeBpm: z.number().min(20).max(400),
  metronomeOffsetMs: z.number().min(METRONOME_OFFSET_MIN_MS).max(METRONOME_OFFSET_MAX_MS),
  countInBeats: z.union([z.literal(0), z.literal(4), z.literal(8)]),
  loopStartMs: z.number().nonnegative().nullable(),
  loopEndMs: z.number().nonnegative().nullable(),
  loopEnabled: z.boolean(),
  zoom: z.number().min(1).max(100),
  scroll: z.number().nonnegative(),
  selectedStem: stemTypeSchema.nullable(),
  tracks: z.array(trackStateSchema).length(6),
  updatedAt: z.string()
}).refine((value) => new Set(value.tracks.map((track) => track.stemType)).size === STEM_ORDER.length, {
  message: '练习状态必须包含六条唯一音轨'
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
  overwriteMode: z.enum(['ask', 'overwrite', 'rename'])
}).refine((value) => new Set(value.stemTypes).size === value.stemTypes.length, '导出音轨不能重复')
  .refine((value) => !value.applyLoopRange || (value.loopStartMs !== null && value.loopEndMs !== null && value.loopEndMs > value.loopStartMs), 'A–B 导出范围无效')

export const listSongsSchema = z.object({
  query: z.string().max(200).default(''),
  filter: z.enum(['all', 'favorite', 'processing', 'recent']).default('all')
})

export const uuidSchema = z.string().uuid()

const httpsUrlSchema = z.string().url().max(2000).refine((value) => new URL(value).protocol === 'https:', '必须使用 HTTPS')

export const networkSettingsSchema = z.object({
  proxyMode: z.enum(['system', 'manual', 'none']),
  proxyUrl: z.string().max(2000),
  pythonIndexUrl: httpsUrlSchema,
  pytorchIndexUrl: z.union([z.literal(''), httpsUrlSchema])
})

export const appSettingsSchema = z.object({
  libraryRoot: z.string().min(3).max(1000),
  runtimeRoot: z.string().min(3).max(1000),
  modelRoot: z.string().min(3).max(1000),
  preferredDevice: computeDeviceSchema,
  audioOutputDeviceId: z.string().max(500),
  latencyMode: z.enum(['interactive', 'balanced', 'playback']),
  keepSource: z.boolean(),
  closeToTrayWhileWorking: z.boolean(),
  network: networkSettingsSchema
})
