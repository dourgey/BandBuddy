import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HarmonyAudio } from '../src/renderer/src/woodshed/harmony-audio.js'
vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
let now = 0
const starts: number[] = [], stops: ReturnType<typeof vi.fn>[] = []
let resume = async (): Promise<void> => {}
class Context {
  get currentTime() { return now }
  destination = {}
  resume() { return resume() }
  close = vi.fn(async () => {})
  createGain() { return { gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
  createOscillator() { const stop = vi.fn(); stops.push(stop); return { frequency: {value:0}, type:'', connect:vi.fn(), disconnect:vi.fn(), start:(at:number)=>starts.push(at), stop, onended:null } }
}
beforeEach(() => { now=0; starts.length=0; stops.length=0; resume=async()=>{}; vi.useFakeTimers(); vi.stubGlobal('AudioContext',Context) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('schedules simultaneous chord voices and advances UI only at audio time',async()=>{
  const audio=new HarmonyAudio(), cursor=vi.fn(), end=vi.fn()
  await audio.play([{notes:[60,64,67],beats:1},{notes:[62],beats:1}],120,false,cursor,end)
  expect(starts).toEqual([.04,.04,.04]); expect(cursor).not.toHaveBeenCalled()
  now=.05; vi.advanceTimersByTime(25); expect(cursor).toHaveBeenCalledWith(0)
  now=.5; vi.advanceTimersByTime(25); expect(starts[3]).toBeCloseTo(.54)
  now=.55; vi.advanceTimersByTime(25); expect(cursor).toHaveBeenLastCalledWith(1)
  now=1.05; vi.advanceTimersByTime(25); expect(end).toHaveBeenCalledOnce(); audio.destroy()
})
it('does not emit a late note when stopped while the device is resuming',async()=>{
  let ready!:()=>void; resume=()=>new Promise(resolve=>{ready=resolve})
  const audio=new HarmonyAudio(), pending=audio.preview([60])
  await Promise.resolve(); await Promise.resolve(); audio.stop(); ready(); await pending
  expect(starts).toEqual([]); audio.destroy()
})
it('loops on the same audio timeline and destroys all pending playback',async()=>{
  const audio=new HarmonyAudio(), cursor=vi.fn(), end=vi.fn()
  await audio.play([{notes:[60],beats:1}],120,true,cursor,end)
  now=.5; vi.advanceTimersByTime(25)
  expect(starts).toHaveLength(2); expect(end).not.toHaveBeenCalled()
  audio.destroy(); now=2; vi.advanceTimersByTime(500)
  expect(starts).toHaveLength(2); expect(stops.every(stop=>stop.mock.calls.length===2)).toBe(true)
})
