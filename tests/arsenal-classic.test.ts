import { describe, expect, it } from 'vitest'
import { CLASSIC_AMPS, CLASSIC_CABS, CLASSIC_MODS, defaultEffectChain, effectChainSchema, effectStructureKey, trackEffectsSchema } from '../packages/shared/src/arsenal.js'

describe('classic device snapshots', () => {
  it('migrates old NAM/IR snapshots without enabling new processors', () => {
    const old = JSON.parse(JSON.stringify(defaultEffectChain()))
    delete old.mod; delete old.drive
    delete old.amp.engine; delete old.amp.classic; delete old.cab.engine; delete old.cab.physical
    old.order = ['reverb', 'amp', 'delay', 'eq']
    const result = effectChainSchema.parse(old)
    expect(result.order).toEqual(['drive', 'reverb', 'amp', 'mod', 'delay', 'eq'])
    expect(result.mod.enabled).toBe(false)
    expect(result.drive.enabled).toBe(false)
    expect(result.amp.engine).toBe('nam')
    expect(result.cab.engine).toBe('ir')
    expect(effectChainSchema.parse(result)).toEqual(result)
  })
  it('requires all original blocks and rejects duplicates and unknown circuits', () => {
    const c = defaultEffectChain()
    for (const order of [['amp', 'eq', 'mod', 'reverb'], ['amp', 'eq', 'delay', 'reverb', 'mod', 'mod']])
      expect(effectChainSchema.safeParse({ ...c, order }).success).toBe(false)
    for (const bad of [NaN, Infinity, -.1, 1.1])
      expect(effectChainSchema.safeParse({ ...c, amp: { ...c.amp, classic: { ...c.amp.classic, bass: bad } } }).success).toBe(false)
    expect(effectChainSchema.safeParse({ ...c, cab: { ...c.cab, physical: { ...c.cab.physical, volumeLitres: 0 } } }).success).toBe(false)
    expect(effectChainSchema.safeParse({ ...c, mod: { ...c.mod, feedback: 1 } }).success).toBe(false)
  })
  it('uses immutable topology keys while allowing numerical edits without reloading', () => {
    const c = defaultEffectChain(), key = effectStructureKey(c)
    c.amp.classic.gain = .9; c.cab.physical.volumeLitres = 200; c.mod.depth = .1
    expect(effectStructureKey(c)).toBe(key)
    for (const device of CLASSIC_AMPS) expect(effectChainSchema.parse({ ...c, amp: { ...c.amp, engine: 'classic', classic: { ...c.amp.classic, device: device.id } } }).amp.engine).toBe('classic')
    for (const device of CLASSIC_CABS) expect(effectChainSchema.parse({ ...c, cab: { ...c.cab, physical: { ...c.cab.physical, device: device.id } } }).cab.physical.device).toBe(device.id)
    for (const device of CLASSIC_MODS) expect(effectChainSchema.parse({ ...c, mod: { ...c.mod, device: device.id } }).mod.device).toBe(device.id)
    c.amp.engine = 'classic'; expect(effectStructureKey(c)).not.toBe(key)
    const snapshot = trackEffectsSchema.parse({ enabled: true, chain: c, presetId: null, monitorMode: 'dry' })
    c.amp.classic.gain = 0
    expect(snapshot.chain.amp.classic.gain).toBe(.9)
    expect(snapshot.monitorMode).toBe('dry')
  })
})
