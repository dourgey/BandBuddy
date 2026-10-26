import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ToneAsset } from '@shared/arsenal.js'
import { bundledIrCatalogSchema } from '@shared/cabinet-ir-library.js'

/** Read metadata once. WAV decoding and sample-rate conversion remain on demand. */
export function loadBundledIrs(root?: string): Map<string, { asset: ToneAsset; file: string }> {
  if (!root) return new Map()
  const catalog = bundledIrCatalogSchema.parse(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')))
  return new Map(catalog.assets.map(({ file, ...asset }) => [asset.id, { asset, file: path.join(root, file) }]))
}

/** Personal labels never replace a bundled file's source, audio metadata or license. */
export function personalizeBundledIr(asset: ToneAsset, saved?: ToneAsset): ToneAsset {
  return saved ? { ...asset, name: saved.name, tags: saved.tags, favorite: saved.favorite, role: saved.role, notes: saved.notes } : asset
}
