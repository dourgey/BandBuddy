// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { arsenalDestination } from '../src/renderer/src/arsenal/native-output.js'
import { nativeOutputRoutes } from '../src/renderer/src/arsenal/output-coordinator.js'

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
class Gain {
  gain = { value: 1, setValueAtTime: vi.fn() }
  connect() { return this }
  disconnect() {}
}
class Tap extends Gain {
  static latest: Tap
  port = { onmessage: (_event: { data: unknown }) => {}, postMessage: vi.fn() }
  constructor() { super(); Tap.latest = this }
}
let emit: (state: { active: boolean }) => void
let stateChanged: () => void
let context: { currentTime: number; sampleRate: number; state: string; destination: Gain; audioWorklet: { addModule: () => Promise<void> }; createGain: () => Gain; setSinkId: ReturnType<typeof vi.fn>; addEventListener: (type: string, listener: () => void) => void; removeEventListener: () => void }
let feed: ReturnType<typeof vi.fn>, monitor: ReturnType<typeof vi.fn>
const version = () => Tap.latest.port.postMessage.mock.calls.filter(([m]) => m.enabled === true).at(-1)![0].epoch as number
const send = (epoch: number, time = context.currentTime) => Tap.latest.port.onmessage({ data: { epoch, time, samples: new Float32Array(2048) } })
beforeEach(async () => {
  vi.stubGlobal('AudioWorkletNode', Tap)
  feed = vi.fn(async () => true); monitor = vi.fn(async () => { emit({ active: false }); return {} })
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { arsenal: {
    feed, monitor, onMonitor: (fn: typeof emit) => { emit = fn; return () => {} }, monitorState: async () => ({ active: false })
  } } })
  context = { currentTime: 1, sampleRate: 48000, state: 'running', destination: new Gain(), audioWorklet: { addModule: async () => {} }, createGain: () => new Gain(), setSinkId: vi.fn(async () => {}), addEventListener: (_type, fn) => { stateChanged = fn }, removeEventListener: () => {} }
  arsenalDestination(context as unknown as AudioContext)
  await flush(); emit({ active: true }); await flush()
  feed.mockClear()
})
afterEach(async () => { context.state = 'closed'; stateChanged(); await flush(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('bounds worklet messages during a UI stall and ignores acknowledgments from an earlier monitor session', () => {
  let Processor: any
  const packets: any[] = []
  runInNewContext(readFileSync('src/renderer/src/arsenal/native-output.worklet.js', 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (packet: unknown) => packets.push(packet), onmessage: (_event: unknown) => {} } },
    registerProcessor: (_name: string, ctor: unknown) => { Processor = ctor }, currentTime: 1, Float32Array
  })
  const tap = new Processor()
  tap.port.onmessage({ data: { enabled: true, epoch: 1 } })
  for (let i = 0; i < 1000; i++) tap.process([[new Float32Array(128).fill(.2)]])
  expect(packets).toHaveLength(4)
  tap.port.onmessage({ data: { ack: true, epoch: 1 } })
  for (let i = 0; i < 8; i++) tap.process([[new Float32Array(128).fill(.4)]])
  expect(packets).toHaveLength(5)
  expect(packets.at(-1).samples[0]).toBeCloseTo(.4)
  tap.port.onmessage({ data: { enabled: false, epoch: 2 } })
  tap.port.onmessage({ data: { enabled: true, epoch: 3 } })
  tap.port.onmessage({ data: { ack: true, epoch: 1 } })
  for (let i = 0; i < 1000; i++) tap.process([[]])
  expect(packets).toHaveLength(9)
})
it('does not stop monitoring for a temporarily slow transfer or stale queued audio', async () => {
  let complete!: (ok: boolean) => void
  feed.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const epoch = version()
  for (let i = 0; i < 4; i++) send(epoch)
  await flush()
  expect(feed).toHaveBeenCalledOnce()
  context.currentTime += .4
  complete(true); await flush()
  expect(feed).toHaveBeenCalledOnce() // queued packets have expired, not replayed
  expect(monitor).not.toHaveBeenCalled()
  expect(Tap.latest.port.postMessage.mock.calls.filter(([m]) => m.ack)).toHaveLength(4)
  send(epoch); await flush()
  expect(feed).toHaveBeenCalledTimes(2)
  expect(monitor).not.toHaveBeenCalled()
})
it('ignores an old rejected transfer while recording stops and monitoring restarts', async () => {
  let reject!: (error: Error) => void
  feed.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const old = version(); send(old); await flush()
  emit({ active: false }); emit({ active: true })
  reject(new Error('old device closed')); await flush()
  expect(version()).not.toBe(old)
  expect(monitor).not.toHaveBeenCalled()
  send(old); await flush()
  const sends = feed.mock.calls.filter(([packet]) => !packet.reset).length
  send(version()); await flush()
  expect(feed.mock.calls.filter(([packet]) => !packet.reset)).toHaveLength(sends + 1)
})
it('does stop monitoring on a real transport timeout and restores browser output', async () => {
  vi.useFakeTimers()
  feed.mockImplementationOnce(() => new Promise(() => {}))
  send(version()); await flush()
  await vi.advanceTimersByTimeAsync(5001); await flush()
  expect(monitor).toHaveBeenCalledOnce()
  expect(context.setSinkId).toHaveBeenLastCalledWith('')
})
it('does not schedule output transitions for each meter event', async () => {
  const calls = context.setSinkId.mock.calls.length
  for (let i = 0; i < 500; i++) emit({ active: true })
  await flush()
  expect(context.setSinkId).toHaveBeenCalledTimes(calls)
  expect(nativeOutputRoutes.size).toBe(1)
})
