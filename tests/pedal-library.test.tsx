// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CLASSIC_AMPS, CLASSIC_CABS, CLASSIC_MODS, WHITEBOX_DEVICES, createEffectModule, effectChainSchema, defaultEffectChain, storeEffectChain, effectStructureKey } from '@shared/arsenal.js'
import { effectDefinition, changeModuleParameter } from '@shared/effect-catalog.js'
import { ModuleControls } from '../src/renderer/src/arsenal/ModuleControls.js'
afterEach(cleanup)
it('uses independent numeric names for all builtins and stores stable DSP identities',()=>{
  for(const list of [CLASSIC_AMPS,CLASSIC_CABS,CLASSIC_MODS,WHITEBOX_DEVICES])for(const item of list){expect(item.name).toMatch(/\d/);expect(item.name).toMatch(/^[A-Za-z0-9 -]+$/);expect(item.name).not.toMatch(/BOSS|Fender|Marshall|VOX|MESA|Orange|Klon|MXR|Dunlop|TS808|Phase 90/)}
  for(const device of ['centaur'] as const){const m=createEffectModule('drive');m.settings.drive.device=device;const c=effectChainSchema.parse(storeEffectChain({...defaultEffectChain(),modules:[m]}));expect(c.modules?.[0]?.settings.drive.device).toBe(device);expect(effectDefinition(m).identity?.prototype).toBe('Klon Centaur')}
  for(const device of ['stereo-chorus','step-flanger','aqueduct-vibrato','fixed-wah'] as const){const m=createEffectModule('mod');m.settings.mod.device=device;expect(effectChainSchema.parse(storeEffectChain({...defaultEffectChain(),modules:[m]})).modules?.[0]?.settings.mod.device).toBe(device)}
})
it('shows the prototype in a compact visible block and distinguishes mode controls',()=>{
  const m=createEffectModule('mod');m.settings.mod.device='aqueduct-vibrato';m.settings.mod.waveform='env-pitch'
  const onChange=vi.fn();const {rerender}=render(<ModuleControls module={m} assets={[]} onChange={onChange}/>)
  expect(screen.getByRole('heading',{name:'Multi Vibrato 08'})).toBeTruthy();expect(screen.getByLabelText('原型说明').textContent).toContain('EarthQuaker Devices Aqueduct')
  expect(screen.getByRole('slider',{name:'Mix'})).toBeTruthy();expect(screen.queryByRole('slider',{name:'Depth'})).toBeNull()
  m.settings.mod.device='fixed-wah';rerender(<ModuleControls module={m} assets={[]} onChange={onChange}/>)
  expect(screen.getByRole('slider',{name:'Peak'})).toBeTruthy();expect(screen.getByRole('slider',{name:'Q'})).toBeTruthy();expect(screen.queryByRole('slider',{name:'Rate'})).toBeNull()
  fireEvent.wheel(screen.getByRole('slider',{name:'Peak'}),{deltaY:-100});expect(onChange.mock.calls.at(-1)?.[0].settings.mod.manual).toBeCloseTo(.55)
})
it('keeps signed feedback and eight vibrato modes across persisted presets',()=>{
  let m=createEffectModule('mod');m.settings.mod.device='step-flanger';m=changeModuleParameter(m,'mod.feedback',-.75);m=changeModuleParameter(m,'mod.sweepMode','step')
  const c=effectChainSchema.parse(storeEffectChain({...defaultEffectChain(),modules:[m]}));expect(c.modules?.[0]?.settings.mod).toMatchObject({feedback:-.75,sweepMode:'step'})
  m.settings.mod.device='aqueduct-vibrato';expect(effectDefinition(m).choices.find(x=>x.path==='mod.waveform')?.options).toHaveLength(8)
})
it('updates knobs in place and prepares mode switches for the existing host crossfade',()=>{
  const c=defaultEffectChain();c.mod.device='aqueduct-vibrato';const before=effectStructureKey(c)
  c.mod.depth=.2;c.mod.rateHz=4;expect(effectStructureKey(c)).toBe(before)
  c.mod.waveform='env-pitch';expect(effectStructureKey(c)).not.toBe(before)
  c.mod.device='step-flanger';const flanger=effectStructureKey(c);c.mod.feedback=-.75;expect(effectStructureKey(c)).toBe(flanger)
  c.mod.sweepMode='dynamic';expect(effectStructureKey(c)).not.toBe(flanger)
})
