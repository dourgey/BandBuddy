import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEffectModule, defaultEffectChain, effectChainSchema, storeEffectChain } from '@shared/arsenal.js'
import { bundledIrCatalogSchema } from '@shared/cabinet-ir-library.js'
import { ArsenalService, decodeIr } from '../src/main/arsenal.js'

const { openDialog, saveDialog, openExternal } = vi.hoisted(() => ({ openDialog: vi.fn(), saveDialog: vi.fn(), openExternal: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog: openDialog, showSaveDialog: saveDialog }, shell: { openExternal } }))

const resources = path.resolve('resources/cabinet-irs')
const catalog = bundledIrCatalogSchema.parse(JSON.parse(await readFile(path.join(resources, 'manifest.json'), 'utf8')))

describe('bundled cabinet IR library', () => {
  let root: string, sqlite: DatabaseSync
  function service(resourceRoot = resources): ArsenalService {
    return new ArsenalService({ dataRoot: root, cabinetIrRoot: () => resourceRoot } as never, { sqlite } as never,
      {} as never, { onEvent: vi.fn() } as never, {} as never, vi.fn(), vi.fn(), () => false)
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bb-bundled-irs-'))
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE tone_assets(id TEXT PRIMARY KEY,json TEXT,created_at TEXT); CREATE TABLE arsenal_presets(id TEXT PRIMARY KEY,json TEXT,updated_at TEXT)')
    openDialog.mockReset(); saveDialog.mockReset(); openExternal.mockReset()
  })
  afterEach(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }) })

  it('provides all licensed WAVs offline, retaining their complete audio and original hashes', async () => {
    const a = service()
    expect(a.list().assets).toHaveLength(72)
    expect(catalog.assets.filter(a => a.attribution.license === 'CC0-1.0')).toHaveLength(31)
    expect(catalog.assets.filter(a => a.metadata.cabinet === 'Korg AX1500g cabinet simulation')).toHaveLength(10)
    expect(a.list().presets).toEqual([])
    expect((sqlite.prepare('SELECT count(*) AS n FROM tone_assets').get() as { n: number }).n).toBe(0)
    for (const asset of catalog.assets) {
      const bytes = await readFile(path.join(resources, asset.file)), decoded = decodeIr(bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.id)
      expect(decoded.sampleRate).toBe(asset.sampleRate)
      expect(decoded.channels.length).toBe(asset.channels)
      expect(decoded.bitDepth).toBe(asset.metadata.bitDepth)
      expect(decoded.channels[0]!.length).toBe(asset.metadata.frames)
      const cab = createEffectModule('cab'); cab.settings.cab.engine = 'ir'; cab.settings.cab.assetId = asset.id
      const prepared = await a.prepare({ ...defaultEffectChain(), modules: [cab] })
      expect(prepared.modules?.[0]?.ir).toEqual(decoded.channels)
      expect(prepared.modules?.[0]?.irRate).toBe(decoded.sampleRate)
    }
    // Loading and preparation never copy WAVs into the user profile.
    expect(await readdir(root)).toEqual([])
  })

  it('restores primary and secondary IRs after restart and a preset export/import', async () => {
    const a = service(), first = catalog.assets[0]!, second = catalog.assets.find(a => a.sampleRate === 44100)!
    const cab = createEffectModule('cab')
    cab.settings.cab = { ...cab.settings.cab, engine: 'ir', assetId: first.id, secondaryAssetId: second.id, blend: .3 }
    const chain = effectChainSchema.parse(storeEffectChain({ ...defaultEffectChain(), modules: [cab] }))
    const preset = a.savePreset({ name: '内置双箱体', chain })
    const file = path.join(root, 'tone.bbtone'); saveDialog.mockResolvedValue({ canceled: false, filePath: file })
    await a.command({ action: 'exportPreset', preset })
    const b = service(); b.deletePreset(preset.id)
    openDialog.mockResolvedValue({ canceled: false, filePaths: [file] })
    await b.command({ action: 'importPreset' })
    const restored = b.list().presets[0]!.chain, prepared = (await b.prepare(restored)).modules![0]!
    expect(restored.modules?.[0]?.settings.cab).toMatchObject({ assetId: first.id, secondaryAssetId: second.id, blend: .3 })
    expect(prepared.irRate).toBe(48000); expect(prepared.secondaryIrRate).toBe(44100)
    expect(prepared.ir?.[0]?.length).toBe(first.metadata.frames)
    expect(prepared.secondaryIr?.[0]?.length).toBe(second.metadata.frames)
  })

  it('deduplicates reimports and persists personal labels without changing attribution or WAVs', async () => {
    const a = service(), asset = catalog.assets[0]!
    openDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(resources, asset.file)] })
    expect(await a.importAsset('ir')).toMatchObject({ id: asset.id, bundled: true })
    expect(a.list().assets).toHaveLength(72)
    await a.command({ action: 'asset', id: asset.id, name: asset.name, tags: asset.tags, notes: '', role: 'unknown', favorite: false })
    await a.command({ action: 'asset', id: asset.id, name: '我的绿背', tags: ['收藏'], notes: '练习', role: 'unknown', favorite: true })
    const restored = service().list().assets.find(a => a.id === asset.id)!
    expect(restored).toMatchObject({ name: '我的绿背', favorite: true, bundled: true, attribution: asset.attribution, metadata: asset.metadata })
    await expect(a.deleteAsset(asset.id)).rejects.toThrow('内置 IR')
    expect(createHash('sha256').update(await readFile(path.join(resources, asset.file))).digest('hex')).toBe(asset.id)
  })

  it('loads a packaged resource copy and rejects tampered WAVs before decoding', async () => {
    const packaged = path.join(root, 'app-resources/cabinet-irs')
    await cp(resources, packaged, { recursive: true })
    const asset = catalog.assets[0]!, a = service(packaged), cab = createEffectModule('cab')
    cab.settings.cab.engine = 'ir'; cab.settings.cab.assetId = asset.id
    expect((await a.prepare({ ...defaultEffectChain(), modules: [cab] })).modules?.[0]?.irRate).toBe(asset.sampleRate)
    const file = path.join(packaged, asset.file), bytes = await readFile(file); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await writeFile(file, bytes)
    await expect(service(packaged).prepare({ ...defaultEffectChain(), modules: [cab] })).rejects.toThrow('校验失败')
  })

  it('opens the selected file source and license using only the bundled catalog URLs', async () => {
    const a = service(), asset = catalog.assets[0]!
    await a.command({ action: 'assetLink', id: asset.id, link: 'source' })
    await a.command({ action: 'assetLink', id: asset.id, link: 'license' })
    expect(openExternal.mock.calls).toEqual([[asset.attribution.sourceUrl], [asset.attribution.licenseUrl]])
    await expect(a.command({ action: 'assetLink', id: 'f'.repeat(64), link: 'source' })).rejects.toThrow('来源不存在')
    expect(openExternal).toHaveBeenCalledTimes(2)
  })
})
