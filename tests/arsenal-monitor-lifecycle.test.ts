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
