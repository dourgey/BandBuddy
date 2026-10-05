import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { artifactValid, writeJsonAtomic, downloadBatch, type Artifact, type DownloadProgress } from './artifact-download.js'
import type { NetworkSettings } from '@shared/domain.js'
import type { RuntimeNetwork } from './runtime-network.js'

export interface ModelCatalog { directory: string; repository: string; revision: string; bag: string; files: Artifact[] }
export async function modelCatalog(packagedRoot: string): Promise<ModelCatalog> {
  const file = existsSync(path.join(packagedRoot, 'model-catalog.json')) ? path.join(packagedRoot, 'model-catalog.json') : path.join(process.cwd(), 'resources/model-catalog.json')
  const catalog = JSON.parse(await readFile(file, 'utf8')) as ModelCatalog
  if (!/^[\w.-]+$/.test(catalog.directory) || !catalog.files?.length || catalog.files.some(item => !/^[\w.+-]+$/.test(item.filename))) throw new Error('MODEL_CATALOG_INVALID')
  return catalog
}
export async function prepareModels(catalog: ModelCatalog, root: string, network: RuntimeNetwork, settings: NetworkSettings, signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<void> {
  const directory = path.join(root, catalog.directory)
  await mkdir(directory, { recursive: true })
  await downloadBatch(catalog.files, signal, (file, childSignal) => network.download(file, path.join(directory, file.filename), settings, childSignal, progress))
  signal.throwIfAborted()
  // Use the original worker marker protocol; Python remains the final verifier.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(directory, 'htdemucs_6s.yaml'), catalog.bag, 'utf8')
  await writeJsonAtomic(path.join(directory, '.bundle-complete.json'), { repository: catalog.repository, revision: catalog.revision, files: Object.fromEntries(catalog.files.map(file => [file.filename, file.sha256])) })
}
export async function modelsValid(catalog: ModelCatalog, root: string): Promise<boolean> {
  for (const file of catalog.files) if (!await artifactValid(path.join(root, catalog.directory, file.filename), file)) return false
  return true
}
