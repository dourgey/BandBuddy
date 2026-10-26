import { z } from 'zod'

export const irAttributionSchema = z.object({
  author: z.string().min(1),
  title: z.string().min(1),
  sourceUrl: z.url().startsWith('https://'),
  license: z.enum(['CC0-1.0', 'CC-BY-4.0']),
  licenseUrl: z.url().startsWith('https://creativecommons.org/'),
  changes: z.string().min(1),
  credit: z.string().min(1)
})
export type IrAttribution = z.infer<typeof irAttributionSchema>

export const bundledIrCatalogSchema = z.object({
  version: z.literal(1),
  assets: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    file: z.string().regex(/^[a-z0-9-]+\/[a-zA-Z0-9_.-]+\.wav$/),
    kind: z.literal('ir'),
    bundled: z.literal(true),
    name: z.string().min(1).max(100),
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(2),
    durationMs: z.number().positive().max(2000),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
    tags: z.array(z.string().max(30)).max(20),
    attribution: irAttributionSchema
  })).min(1)
}).refine(catalog => new Set(catalog.assets.map(a => a.id)).size === catalog.assets.length, '重复的内置 IR')

export type BundledIrCatalog = z.infer<typeof bundledIrCatalogSchema>
