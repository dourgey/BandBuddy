// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { SampleBank } from '../src/renderer/src/instrument-workshop/samples.js'
afterEach(() => vi.unstubAllGlobals())
it('decodes local compressed assets once and schedules nearest guitar pitch with release cleanup', async () => {
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => [{group:'electric-clean',midi:60,url:'clean.ogg'},{group:'drums',midi:36,url:'kick.ogg'}], arrayBuffer: async () => new ArrayBuffer(8) }))
  vi.stubGlobal('fetch', fetch)
  const source = { buffer: null, playbackRate: {setValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),addEventListener:vi.fn() }
  const gain = {gain:{setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn()};source.connect.mockReturnValue(gain)
  const context = {decodeAudioData:vi.fn(async () => ({duration:2})),createBufferSource:()=>source,createGain:()=>gain}
  const bank = new SampleBank(context as unknown as AudioContext)
  await Promise.all([bank.ready(),bank.ready()]);expect(fetch).toHaveBeenCalledTimes(3)
  bank.play('electric-clean',72,3,.5,.2,{} as AudioNode)
  expect(source.playbackRate.setValueAtTime).toHaveBeenLastCalledWith(2,3)
  expect(source.start).toHaveBeenCalledWith(3);expect(source.stop).toHaveBeenCalledWith(3.505)
  expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0,3.5)
  source.addEventListener.mock.calls[0]![1]();expect(source.disconnect).toHaveBeenCalled();expect(gain.disconnect).toHaveBeenCalled()
  bank.play('drums',36,4,1,.3,{} as AudioNode);expect(source.playbackRate.setValueAtTime).toHaveBeenLastCalledWith(1,4)
})
