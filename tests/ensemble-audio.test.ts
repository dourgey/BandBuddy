import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnsembleAudio, type EnsemblePlayback } from '../src/renderer/src/woodshed/ensemble-audio.js'
import type { EnsembleScore } from '../src/renderer/src/woodshed/ensemble-material.js'
import { setAudioContextOutputDevice } from '../src/renderer/src/audio-engine.js'
vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
class Param { value = 0; setValueAtTime = vi.fn(); linearRampToValueAtTime = vi.fn(); exponentialRampToValueAtTime = vi.fn() }
class Node { connect = vi.fn(); disconnect = vi.fn(); gain = new Param(); frequency = new Param(); detune = new Param(); type = ''; onended: (() => void) | null = null; start = vi.fn(); stop = vi.fn() }
const sounds: Node[] = []
class Context {
 destination = {}; sampleRate = 100; outputLatency = 0
 get currentTime() { return Date.now() / 1000 }
 resume = vi.fn(async () => {}); close = vi.fn(async () => {})
 createGain() { return new Node() }
 createBiquadFilter() { return new Node() }
 createOscillator() { const n = new Node(); sounds.push(n); return n }
 createBuffer() { return { getChannelData: () => new Float32Array(100) } }
 createBufferSource() { const n = new Node(); sounds.push(n); return n }
}
const options: EnsemblePlayback = { bpm: 60, demo: true, countIn: 0, silentBars: 0, attack: .01, release: .1, cutoff: 5000, waveform: 'triangle' }
const score: EnsembleScore = { name:'6/8',description:'test',meter:'6/8',beatUnit:1.5,bars:1,events:[{id:'R-0',beat:0,duration:1.5,notes:[60],hand:'R',velocity:.5},{id:'R-1',beat:1.5,duration:1.5,notes:[64],hand:'R',velocity:.5}] }
beforeEach(() => { sounds.length=0; vi.useFakeTimers(); vi.setSystemTime(0); vi.stubGlobal('AudioContext',Context); vi.mocked(setAudioContextOutputDevice).mockResolvedValue(undefined) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('ensemble audio clock and lifecycle', () => {
 it('uses the dotted-quarter BPM for both notes and pulse scheduling', async () => {
  const audio=new EnsembleAudio();await audio.start(score,options,'output-A')
  await vi.advanceTimersByTimeAsync(1100)
  const e=sounds.find(s=>Math.abs(s.frequency.value-329.6275569)<.01)!
  expect(e).toBeDefined();expect(e.start).toHaveBeenCalledWith(1.07)
  expect(setAudioContextOutputDevice).toHaveBeenCalledWith(expect.any(Context),'output-A')
  expect(audio.position).toBeCloseTo(1.545,2)
  audio.destroy()
 })
 it('mutes complete bars including reference notes and visual cues', async () => {
  const audio=new EnsembleAudio();await audio.start({...score,meter:'4/4',beatUnit:1,events:[]},{...options,demo:false,silentBars:1},'')
  await vi.advanceTimersByTimeAsync(4500)
  expect(sounds).toHaveLength(4);expect(audio.silent).toBe(true)
  await vi.advanceTimersByTimeAsync(3000);expect(sounds).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(700);expect(sounds).toHaveLength(5);expect(audio.silent).toBe(false)
  audio.destroy()
 })
 it('cancels an output-routing race and never schedules sound after disposal', async () => {
  let release!:()=>void
  vi.mocked(setAudioContextOutputDevice).mockImplementationOnce(()=>new Promise<void>(r=>{release=r}))
  const audio=new EnsembleAudio(),pending=audio.start(score,options,'slow-device')
  audio.destroy();release()
  expect(await pending).toBe(false);expect(sounds).toHaveLength(0)
  expect(await audio.start(score,options,'')).toBe(false)
 })
 it('stops active and future sources on navigation or cancellation', async () => {
  const audio=new EnsembleAudio();await audio.start(score,options,'')
  expect(sounds.length).toBeGreaterThan(0);audio.stop()
  const count=sounds.length;await vi.advanceTimersByTimeAsync(10000)
  expect(sounds).toHaveLength(count);for(const sound of sounds)expect(sound.stop).toHaveBeenCalled()
  expect(audio.position).toBe(-1);audio.destroy()
 })
})
