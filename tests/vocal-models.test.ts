import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareVocalModel, type VocalCatalog } from '../src/main/vocal-models.js'
import { VOCAL_SEPARATION_PROFILES } from '@shared/domain.js'
import type { AppPaths } from '../src/main/paths.js'

const network = vi.hoisted(() => ({ download: vi.fn(), close: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../src/main/runtime-network.js', () => ({ RuntimeNetwork: class {
  download = network.download
  close = network.close
} }))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('packaged vocal model preparation', () => {
  it.each(['fast', 'high'] as const)('prepares the %s model using the packaged catalog and verifies its download', async quality => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bb-vocal-model-')); roots.push(root)
    const catalog = JSON.parse(await readFile('resources/vocal-model-catalog.json', 'utf8')) as VocalCatalog
    const id = VOCAL_SEPARATION_PROFILES[quality].modelId
    const model = catalog.models.find(model => model.id === id)!
    const checkpoint = Buffer.from(`test checkpoint for ${id}`)
    model.size = checkpoint.length
    model.sha256 = createHash('sha256').update(checkpoint).digest('hex')
    const catalogFile = path.join(root, 'vocal-model-catalog.json')
    await writeFile(catalogFile, JSON.stringify(catalog))
    const packagedResource = vi.fn(() => catalogFile)
    const paths = { packagedResource } as unknown as AppPaths
    const settings = { proxyMode: 'none' as const, proxyUrl: '', pythonInstallMirror: '', pythonIndexUrl: '', pytorchIndexUrl: '' }
    network.download.mockImplementation(async (_artifact, file: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, checkpoint) })
    await prepareVocalModel(paths, root, id, settings, new AbortController().signal, vi.fn())
    expect(packagedResource).toHaveBeenCalledWith('vocal-model-catalog.json')
    expect(network.download).toHaveBeenCalledWith(expect.objectContaining({ id }), expect.any(String), settings, expect.any(AbortSignal), expect.any(Function))
    expect(network.close).toHaveBeenCalledOnce()
    // A valid cached checkpoint is reused on the next request.
    await prepareVocalModel(paths, root, id, settings, new AbortController().signal, vi.fn())
    expect(network.download).toHaveBeenCalledOnce()
  })
})
