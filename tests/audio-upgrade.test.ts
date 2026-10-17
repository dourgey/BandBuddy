import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { recoverFloatCapture } from '../src/main/wave-recovery.js'
import { AudioPluginService } from '../src/main/audio-plugins.js'
import { defaultEffectChain, effectChainSchema, storeEffectChain } from '@shared/arsenal.js'

describe('audio upgrade persistence', () => {
  it.runIf(process.platform === 'win32' && process.env.BANDBUDDY_PLUGIN_INTEGRATION === '1')('scans and restores a real VST3 through the application service without opening an audio device', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'BandBuddy 服务 🎸-'))
    const service = new AudioPluginService({ dataRoot: root, audioHostExecutable: () => path.resolve(process.env.BANDBUDDY_TEST_AUDIO_HOST ?? 'resources/audio-host/win32-x64/bandbuddy-audio-host.exe') } as never)
    // Never scan the user's installed plugins in this integration test.
    vi.stubEnv('LOCALAPPDATA', root); vi.stubEnv('ProgramFiles', root)
    try {
      await service.addDirectory(path.resolve('native/audio-host/build/win32-x64/VST3/Release'))
      const catalog = await service.scan()
      const plugin = catalog.plugins.find(p => p.name === 'ADelay')
      expect(plugin?.validation).toBe('available')
      expect(catalog.failures).toEqual([])
      const instanceId = randomUUID()
      const node = { kind: 'plugin' as const, id: instanceId, instanceId, format: 'vst3' as const, pluginId: plugin!.pluginId, name: plugin!.name, fingerprint: plugin!.fingerprint, stateHash: null as string | null, bypass: false, beforeModuleId: null }
      const prepared = { chain: defaultEffectChain(), model: null, modelRate: 48000, ir: null, irRate: 48000, pluginGraph: { version: 1 as const, inputGainDb: 0, outputGainDb: 0, nodes: [node] } }
      await service.commit(await service.prepare(prepared, 48000))
      const parameter = (await service.parameters(instanceId)).find(p => p.name === 'Delay')!
      await service.parameter(instanceId, parameter.id, .375)
      const hash = await service.save(instanceId)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
      expect((await service.exportStates([hash]))[hash]).toBeTruthy()
      await service.stop()
      node.stateHash = hash
      await service.commit(await service.prepare(prepared, 48000))
      expect((await service.parameters(instanceId)).find(p => p.id === parameter.id)?.value).toBeCloseTo(.375, 6)
      await service.stop()
      expect(await readdir(path.join(root, 'audio-plugins/sessions'))).toEqual([])
    } finally { await service.stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  }, 60000)
  it('repairs both legacy and RF64-reserved captures without including partial frames', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bb-wave-recovery-'))
    try {
      for (const reserve of [false, true]) {
        const offset = reserve ? 80 : 44, bytes = Buffer.alloc(offset + 20 * 8 + 3)
        bytes.write('RIFF'); bytes.write('WAVE', 8)
        if (reserve) { bytes.write('JUNK', 12); bytes.writeUInt32LE(28, 16) }
        const fmt = reserve ? 48 : 12
        bytes.write('fmt ', fmt); bytes.writeUInt32LE(16, fmt + 4); bytes.writeUInt16LE(3, fmt + 8); bytes.writeUInt16LE(2, fmt + 10)
        bytes.writeUInt32LE(48000, fmt + 12); bytes.writeUInt16LE(32, fmt + 22); bytes.write('data', offset - 8)
        const file = path.join(root, `${reserve}.wav`); await writeFile(file, bytes)
        expect(recoverFloatCapture(file).frames).toBe(20)
        const repaired = await readFile(file)
        expect(repaired.length).toBe(offset + 160); expect(repaired.readUInt32LE(offset - 4)).toBe(160)
        expect(repaired.readUInt32LE(4)).toBe(repaired.length - 8)
        expect(repaired.subarray(offset)).toEqual(bytes.subarray(offset, offset + 160))
      }
      const invalid = path.join(root, 'invalid.wav'); await writeFile(invalid, Buffer.alloc(90))
      expect(() => recoverFloatCapture(invalid)).toThrow('CAPTURE_HEADER_INVALID')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('round-trips missing plugin identities and transports authenticated opaque state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bb-plugin-state-'))
    try {
      const service = new AudioPluginService({ dataRoot: root, audioHostExecutable: () => path.join(root, 'host') } as never)
      const state = Buffer.from([0, 255, 12, 0, 35, 99]), hash = createHash('sha256').update(state).digest('hex')
      const chain = { ...defaultEffectChain(), plugins: [{ instanceId: randomUUID(), format: 'vst3' as const, pluginId: 'missing-but-preserved', name: 'Missing plugin', fingerprint: '1'.repeat(64), stateHash: hash, bypass: true, beforeModuleId: null }] }
      expect(effectChainSchema.parse(storeEffectChain(chain)).plugins).toEqual(chain.plugins)
      await service.importStates({ [hash]: state.toString('base64') })
      expect(await service.exportStates([hash])).toEqual({ [hash]: state.toString('base64') })
      await expect(service.importStates({ ['0'.repeat(64)]: state.toString('base64') })).rejects.toThrow('PLUGIN_STATE_INVALID')
      await expect(service.importStates({ '../../outside': 'AA==' })).rejects.toThrow('PLUGIN_STATE_INVALID')
      expect((await service.list()).plugins).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
