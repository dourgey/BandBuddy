import { app } from 'electron'
import path from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { artifactValid, type Artifact, type DownloadProgress } from './artifact-download.js'
import { RuntimeNetwork } from './runtime-network.js'
import type { NetworkSettings, VocalModelId } from '@shared/domain.js'
import type { AppPaths } from './paths.js'

export interface VocalModel extends Artifact {
  id: VocalModelId
  name: string
  architecture: string
  config: string
  configSha256: string
  revision: string
  sourceUrl: string
  sourceConfigUrl: string
}
export interface VocalCatalog { version: 1; repository: string; downloadRevision: string; defaultModelId: VocalModelId; models: VocalModel[] }

export async function vocalCatalog(paths: AppPaths): Promise<VocalCatalog> {
  const file = app.isPackaged ? paths.packagedResource('vocal-model-catalog.json') : path.join(process.cwd(), 'resources/vocal-model-catalog.json')
  const value = JSON.parse(await readFile(file, 'utf8')) as VocalCatalog
  if (value.version !== 1 || !value.models?.some(model => model.id === value.defaultModelId)
    || value.models.some(model => !/^[\w.-]+$/.test(model.id) || !/^[\w.-]+$/.test(model.filename) || !/^[a-f0-9]{64}$/.test(model.sha256))) throw new Error('VOCAL_MODEL_CATALOG_INVALID')
  return value
}

/** Optional models have their own readiness; base separation stays usable. */
export async function prepareVocalModel(paths: AppPaths, root: string, id: VocalModelId, settings: NetworkSettings,
  signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<void> {
  const catalog = await vocalCatalog(paths)
  const model = catalog.models.find(model => model.id === id)
  if (!model) throw new Error('VOCAL_MODEL_UNKNOWN')
  const directory = path.join(root, 'vocal-split-v1', id)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, model.filename)
  if (await artifactValid(file, model)) return
  const network = new RuntimeNetwork()
  try { await network.download(model, file, settings, signal, progress) }
  finally { network.close() }
  signal.throwIfAborted()
  if (!await artifactValid(file, model)) throw new Error('VOCAL_MODEL_HASH_MISMATCH')
}
