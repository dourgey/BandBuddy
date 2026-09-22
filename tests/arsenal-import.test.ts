import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEffectChain } from '@shared/arsenal.js'
import { ArsenalService } from '../src/main/arsenal.js'

const { openDialog } = vi.hoisted(() => ({ openDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog: openDialog } }))

// Synthetic model specs: downloaded captures must not be redistributed as fixtures.
const leaf = () => ({ version: '0.7.0', architecture: 'Linear', sample_rate: 48000, config: { receptive_field: 1, bias: false }, weights: [.5] })
const container = () => ({
  ...leaf(), architecture: 'SlimmableContainer', weights: [],
  config: { submodels: [{ max_value: .5, model: leaf() }, { max_value: 1, model: leaf() }] },
  metadata: { name: 'A2 capture', input_level_dbu: 12 }
})

describe('NAM asset import', () => {
  let root: string, sqlite: DatabaseSync, service: ArsenalService
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bb-nam-import-'))
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE tone_assets(id TEXT PRIMARY KEY,json TEXT,created_at TEXT); CREATE TABLE arsenal_presets(id TEXT PRIMARY KEY,json TEXT,updated_at TEXT)')
    type Args = ConstructorParameters<typeof ArsenalService>
    service = new ArsenalService({ dataRoot: root } as Args[0], { sqlite } as unknown as Args[1], {} as Args[2],
      { onEvent: vi.fn() } as unknown as Args[3], {} as Args[4], vi.fn(), vi.fn(), () => false)
    openDialog.mockReset()
  })
  afterEach(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }) })

  async function select(model: unknown, extension = 'nam'): Promise<string> {
    const file = path.join(root, `capture.${extension}`)
    const text = JSON.stringify(model)
    await writeFile(file, text)
    openDialog.mockResolvedValue({ canceled: false, filePaths: [file] })
    return text
  }

  it('imports A2 containers, preserves both submodels and deduplicates unchanged bytes', async () => {
    const text = await select(container())
    const asset = await service.importAsset('nam')
    expect(asset).toMatchObject({ architecture: 'SlimmableContainer', sampleRate: 48000, slimmable: true, metadata: container().metadata })
    const chain = defaultEffectChain(); chain.amp.enabled = true; chain.amp.assetId = asset!.id
    expect(await service.prepare(chain)).toMatchObject({ model: text, modelRate: 48000 })
    expect(await readFile(path.join(root, 'arsenal', `${asset!.id}.nam`), 'utf8')).toBe(text)
    expect(await service.importAsset('nam')).toEqual(asset)
    expect(service.list().assets).toHaveLength(1)
  })

  it('keeps legacy flat-weight NAM models working', async () => {
    await select(leaf())
    expect(await service.importAsset('nam')).toMatchObject({ architecture: 'Linear', sampleRate: 48000, slimmable: false })
  })

  it('allows selecting nam and nam2 extensions', async () => {
    await select(container(), 'nam2')
    expect(await service.importAsset('nam')).toMatchObject({ name: 'capture', slimmable: true })
    expect(openDialog.mock.calls[0]![0].filters[0].extensions).toEqual(['nam', 'nam2'])
  })

  it.each([
    ['empty ordinary weights', { ...leaf(), weights: [] }],
    ['empty container', { ...container(), config: { submodels: [] } }],
    ['invalid child weights', { ...container(), config: { submodels: [{ max_value: 1, model: { ...leaf(), weights: [null] } }] } }],
    ['missing child', { ...container(), config: { submodels: [{ max_value: 1 }] } }],
    ['unsorted sizes', { ...container(), config: { submodels: [{ max_value: 1, model: leaf() }, { max_value: .5, model: leaf() }] } }],
    ['incomplete size range', { ...container(), config: { submodels: [{ max_value: .5, model: leaf() }] } }],
    ['invalid config', { ...leaf(), config: [] }]
  ])('rejects %s without saving an asset', async (_, model) => {
    await select(model)
    await expect(service.importAsset('nam')).rejects.toThrow('NAM 模型结构无效')
    expect(service.list().assets).toEqual([])
    expect(await readdir(root)).toEqual(['capture.nam'])
  })

  it.skipIf(!process.env.BB_NAM_TEST_MODEL)('imports the externally downloaded Tone3000 capture end to end', async () => {
    const source = process.env.BB_NAM_TEST_MODEL!
    openDialog.mockResolvedValue({ canceled: false, filePaths: [source] })
    const asset = await service.importAsset('nam')
    expect(asset).toMatchObject({ architecture: 'SlimmableContainer', sampleRate: 48000, slimmable: true })
    const chain = defaultEffectChain(); chain.amp.assetId = asset!.id; chain.amp.enabled = true
    expect((await service.prepare(chain)).model).toBe(await readFile(source, 'utf8'))
  })
})
