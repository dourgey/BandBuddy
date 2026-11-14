import { expect, it, vi } from 'vitest'
import { defaultEffectChain } from '../packages/shared/src/arsenal.js'
import { ArsenalService } from '../src/main/arsenal.js'
vi.mock('electron', () => ({ dialog: {} }))
it('serializes a stop behind an in-flight monitor start before releasing the device', async () => {
  let resolveStart!: (value: object) => void
  const host = { onEvent: vi.fn(), startTest: vi.fn(() => new Promise(resolve => { resolveStart = resolve })), stopTest: vi.fn(async () => undefined) }
  const recording = { isActive: () => false, arsenalDeviceConfiguration: async () => ({}) }
  const service = new ArsenalService({ dataRoot: '.' } as never, {} as never, {} as never, host as never, recording as never, vi.fn(), vi.fn(), () => false)
  const chain = { ...defaultEffectChain(), modules: [] }
  const start = service.monitor('wet', chain)
  await vi.waitFor(() => expect(host.startTest).toHaveBeenCalledOnce())
  const stop = service.stopMonitor()
  expect(host.stopTest).not.toHaveBeenCalled()
  resolveStart({ sampleRate: 48000 })
  await Promise.all([start, stop])
  expect(host.stopTest).toHaveBeenCalledOnce()
  expect(service.monitorState()).toMatchObject({ active: false, mode: 'off' })
})

it('monitors a recording track without recording, switches its tone live and protects the current owner', async () => {
  let active = false
  const host = { onEvent: vi.fn(), startTest: vi.fn(async () => ({ sampleRate: 48000 })), stopTest: vi.fn(async () => undefined), setEffects: vi.fn(async () => undefined) }
  const recording = { isActive: () => active, getState: () => ({ recordingTrackId: 'one' }), arsenalDeviceConfiguration: async () => ({ inputChannel: 1 }) }
  const write = vi.fn()
  const db = { getRecordingTrack: () => ({}), getSong: () => null, sqlite: { prepare: () => ({ run: write }) } }
  const service = new ArsenalService({ dataRoot: '.' } as never, db as never, {} as never, host as never, recording as never, vi.fn(), vi.fn(), () => false)
  const chain = { ...defaultEffectChain(), modules: [] }
  await service.setTrack('one', { enabled: false, presetId: null, chain, monitorMode: 'dry' })
  expect(host.startTest).toHaveBeenCalledWith(expect.objectContaining({ inputChannel: 1, monitorMode: 1 }))
  expect(service.monitorState()).toMatchObject({ active: true, trackId: 'one', mode: 'dry' })
  await service.setTrack('one', { enabled: true, presetId: null, chain, monitorMode: 'wet' })
  expect(host.startTest).toHaveBeenCalledOnce()
  expect(host.setEffects).toHaveBeenCalledWith(expect.objectContaining({ mode: 2 }))
  await service.monitor('off', chain, 'other')
  expect(host.stopTest).not.toHaveBeenCalled()
  await service.stopMonitor()
  active = true
  await service.setTrack('one', { enabled: true, presetId: null, chain, monitorMode: 'off' })
  expect(host.setEffects).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 0 }))
  expect(host.startTest).toHaveBeenCalledOnce()
  expect(write).toHaveBeenCalledTimes(3)
})

it.each(['wasapi-shared', 'coreaudio', 'wasapi-exclusive', 'asio'])('accepts redirected accompaniment only when %s needs device handoff', async backend => {
  const host = { onEvent: vi.fn(), startTest: vi.fn(async () => ({ sampleRate: 48000 })), stopTest: vi.fn(async () => undefined), arsenalPcm: vi.fn(async () => true) }
  const recording = { isActive: () => false, arsenalDeviceConfiguration: async () => ({ backend }) }
  const service = new ArsenalService({ dataRoot: '.' } as never, {} as never, {} as never, host as never, recording as never, vi.fn(), vi.fn(), () => false)
  const state = await service.monitor('dry', { ...defaultEffectChain(), modules: [] })
  const redirects = backend === 'asio' || backend === 'wasapi-exclusive'
  expect(state.redirectBrowserOutput).toBe(redirects)
  expect(await service.feed({ bus: 0, sampleRate: 48000, samples: [.2, .2] })).toBe(redirects)
  expect(host.arsenalPcm).toHaveBeenCalledTimes(redirects ? 1 : 0)
})
