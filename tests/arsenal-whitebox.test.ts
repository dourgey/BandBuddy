import { describe, expect, it } from 'vitest'
import { defaultEffectChain, effectChainSchema, effectStructureKey, trackEffectsSchema } from '../packages/shared/src/arsenal.js'

describe('whitebox snapshots', () => {
  it('upgrades legacy chains while leaving the new device bypassed and the old order intact', () => {
    const { drive: _, ...legacy } = defaultEffectChain()
    legacy.order = ['delay', 'amp', 'reverb', 'eq']
    const upgraded = effectChainSchema.parse(legacy)
    expect(upgraded.order).toEqual(['drive', ...legacy.order])
    expect(upgraded.drive.enabled).toBe(false)
    expect(effectChainSchema.parse(upgraded)).toEqual(upgraded)
  })
  it('validates topology, physical input range and finite controls at IPC boundary', () => {
    const chain = defaultEffectChain()
    for (const patch of [{ drive: NaN }, { inputVolts: 0 }, { inputVolts: 11 }, { device: 'mystery' }, { revision: 2 }, { oversampling: 8 }]) {
      expect(effectChainSchema.safeParse({ ...chain, drive: { ...chain.drive, ...patch } }).success).toBe(false)
    }
    for (const order of [['drive','amp','eq','delay'], ['amp','amp','eq','delay'], ['drive','amp','eq','delay','delay']]) {
      expect(effectChainSchema.safeParse({ ...chain, order }).success).toBe(false)
    }
  })
  it('rebuilds for topology and quality but updates ordinary parameters in place', () => {
    const chain = defaultEffectChain(), key = effectStructureKey(chain)
    expect(effectStructureKey({ ...chain, drive: { ...chain.drive, enabled:true, drive:1,tone:0,level:.2,inputVolts:2 } })).toBe(key)
    for (const patch of [{ device: 'rat' as const }, { oversampling: 2 as const }])
      expect(effectStructureKey({ ...chain, drive: { ...chain.drive, ...patch } })).not.toBe(key)
  })
  it('copies track settings independently of library presets', () => {
    const chain=defaultEffectChain();chain.drive.enabled=true;chain.drive.device='sd1'
    const track=trackEffectsSchema.parse({enabled:true,presetId:null,chain,monitorMode:'dry'})
    chain.drive.drive=.9
    expect(track.chain.drive.drive).toBe(.4)
    expect(track.chain.drive.enabled).toBe(true)
    expect(track.monitorMode).toBe('dry')
  })
})
