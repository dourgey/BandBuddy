import { expect, it, vi } from 'vitest'
import { AudioHostClient } from '../src/main/audio-host.js'

it('keeps the complete restorable graph across EQ-only edits and attached recording tones', async () => {
  // Exercise the actual cache logic independently of the device RPC.
  const host = Object.create(AudioHostClient.prototype) as AudioHostClient
  const state = { positionMs: 2400, playing: true }
  Object.assign(host, { requireNativeCapabilities: async () => undefined, request: vi.fn(async () => state), timelineGraph: null })
  await host.timeline({ action: 'load', graph: { sampleRate: 48000, tracks: [{ id: 'vocals', path: 'v.wav', gain: 1 }] } })
  await expect(host.timeline({ action: 'update', state: { eq: { enabled: true } } })).resolves.toEqual(state)
  await host.timeline({ action: 'attach', tracks: [{ id: 'take', path: 'wet.wav', gain: .8 }], state: { tracks: [{ id: 'vocals', gain: .4 }, { id: 'take', gain: .8 }] } })
  expect((host as unknown as { timelineGraph: object }).timelineGraph).toMatchObject({ eq: { enabled: true }, tracks: [{ id: 'vocals', path: 'v.wav', gain: .4 }, { id: 'take', path: 'wet.wav', gain: .8 }] })
  await host.timeline({ action: 'attach', tracks: [{ id: 'take', path: 'new-tone.wav' }], state: { tracks: [{ id: 'take', gain: 1 }] } })
  expect((host as unknown as { timelineGraph: { tracks: object[] } }).timelineGraph.tracks[1]).toEqual({ id: 'take', path: 'new-tone.wav', gain: 1 })
})
