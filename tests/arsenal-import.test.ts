import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEffectModule, defaultEffectChain, storeEffectChain, effectChainSchema, effectStructureKey } from '@shared/arsenal.js'
import { ArsenalService, decodeIr } from '../src/main/arsenal.js'

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
    service = new ArsenalService({ dataRoot: root, audioHostExecutable:()=>path.resolve('resources/audio-host', `${process.platform}-${process.arch}`, `bandbuddy-audio-host${process.platform === 'win32' ? '.exe' : ''}`) } as Args[0], { sqlite } as unknown as Args[1], {} as Args[2],
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
    [-40, 12], [-3, -12], [-18, 0], [-14, -4],
    [null, 0], [undefined, 0], [-101, 0], [1, 0]
  ])('matches reference normalization for loudness %s', async (loudness, adjustmentDb) => {
    await select({ ...container(), metadata: { loudness, input_level_dbu: 15, output_level_dbu: 14 } })
    const asset = await service.importAsset('nam')
    const chain = defaultEffectChain()
    chain.amp = { ...chain.amp, enabled: true, assetId: asset!.id, outputMode: 'normalized', calibration: true, inputDbU: 12 }
    const prepared = await service.prepare(chain)
    expect(prepared.namInputGain).toBeCloseTo(10 ** (-3 / 20), 12)
    expect(prepared.namOutputGain).toBeCloseTo(10 ** (adjustmentDb! / 20), 12)
    chain.amp.outputMode = 'raw'
    expect((await service.prepare(chain)).namOutputGain).toBe(1)
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

  function wave(channels=2, rate=44100):Buffer {
    const frames=300, bytes=Buffer.alloc(44+frames*channels*4)
    bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*4,28);bytes.writeUInt16LE(channels*4,32);bytes.writeUInt16LE(32,34);bytes.write('data',36);bytes.writeUInt32LE(frames*channels*4,40)
    for(let c=0;c<channels;c++)bytes.writeFloatLE(c===0?.5:-.25,44+(100*channels+c)*4)
    return bytes
  }
  it('preserves original stereo IR bytes, phase, delay and metadata through import, prepare and preset restore', async()=>{
    const file=path.join(root,'speaker.wav'),bytes=wave();await writeFile(file,bytes);openDialog.mockResolvedValue({canceled:false,filePaths:[file]})
    const asset=(await service.importAsset('ir'))!;expect(asset).toMatchObject({sampleRate:44100,channels:2,metadata:{bitDepth:32,encoding:'float',processing:'original',leadingSilenceFrames:100}})
    expect(await readFile(path.join(root,'arsenal',`${asset.id}.wav`))).toEqual(bytes)
    const amp=createEffectModule('amp'),cab=createEffectModule('cab');cab.settings.cab.engine='ir';cab.settings.cab.assetId=asset.id
    const chain={...defaultEffectChain(),modules:[amp,cab]};const restored=effectChainSchema.parse(storeEffectChain(chain));expect(restored.modules?.[1]?.settings.cab.assetId).toBe(asset.id)
    const prepared=await service.prepare(restored);expect(prepared.modules?.[1]?.ir?.map(c=>c[100])).toEqual([.5,-.25]);expect(prepared.modules?.[1]?.irRate).toBe(44100)
    expect(await service.importAsset('ir')).toEqual(asset);expect(service.list().assets).toHaveLength(1)
  })
  it('rejects corrupt, nonfinite and silent IR without writing assets',async()=>{
    const silent=wave();silent.fill(0,44)
    const nonfinite=wave();nonfinite.writeFloatLE(NaN,44)
    const truncated=wave().subarray(0,100),badAlign=wave();badAlign.writeUInt16LE(1,32)
    for(const bytes of [silent,nonfinite,truncated,badAlign])expect(()=>decodeIr(bytes)).toThrow()
    const good=path.join(root,'good.wav'),bad=path.join(root,'bad.wav');await writeFile(good,wave());await writeFile(bad,nonfinite)
    openDialog.mockResolvedValue({canceled:false,filePaths:[bad,good]});await expect(service.importAsset('ir')).rejects.toThrow('已导入 1 个，1 个未导入');expect(service.list().assets).toHaveLength(1)
  })
  it('prepares matching amp load and rebuilds when the adjacent cabinet changes, while knob edits stay cheap',async()=>{
    const amp=createEffectModule('amp'),cab=createEffectModule('cab');cab.settings.cab.physical.device='marshall-1960ax';cab.settings.cab.physical.volumeLitres=170
    const chain={...defaultEffectChain(),modules:[amp,cab]};const key=effectStructureKey(chain)
    expect((await service.prepare(chain)).modules?.[0]?.ampLoad).toEqual({device:'marshall-1960ax',volumeLitres:170})
    amp.settings.amp.classic.gain=.9;expect(effectStructureKey(chain)).toBe(key)
    cab.settings.cab.enabled=false;expect(effectStructureKey(chain)).not.toBe(key);expect((await service.prepare(chain)).modules?.[0]?.ampLoad).toBeUndefined()
    cab.settings.cab.enabled=true;const eq=createEffectModule('eq');chain.modules=[amp,eq,cab];expect((await service.prepare(chain)).modules?.[0]?.ampLoad).toBeUndefined()
    const legacy=defaultEffectChain();legacy.order=['amp','cab'];legacy.amp.engine='classic';legacy.amp.classic.device='fender-twin';legacy.cab.engine='physical';legacy.cab.enabled=true
    const legacyKey=effectStructureKey(legacy);legacy.cab.physical.distanceMetres=.5;expect(effectStructureKey(legacy)).toBe(legacyKey)
    legacy.cab.physical.volumeLitres=120;expect(effectStructureKey(legacy)).not.toBe(legacyKey)
    const resized=effectStructureKey(legacy);legacy.cab.enabled=false;expect(effectStructureKey(legacy)).not.toBe(resized)
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
