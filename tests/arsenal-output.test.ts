import { expect, it, vi } from 'vitest'
import { ArsenalOutputTransport } from '../src/main/arsenal-output.js'

const request = (url: string, samples: number[] = [.1, -.2], options: RequestInit = {}): Request =>
  new Request(`${url}?rate=48000`, { method: 'POST', body: new Float32Array(samples).buffer, ...options })

it('delivers stereo binary PCM and resets without involving the renderer IPC queue', async () => {
  const feed = vi.fn(async (_packet: { bus: number; sampleRate: number; samples: number[]; reset?: boolean }) => true)
  const transport = new ArsenalOutputTransport(feed), url = transport.open(2)
  expect((await transport.response(request(url))).status).toBe(204)
  expect(feed.mock.calls[0]![0]).toMatchObject({ bus: 2, sampleRate: 48000, reset: false })
  expect(feed.mock.calls[0]![0].samples[1]).toBeCloseTo(-.2)
  expect((await transport.response(new Request(`${url}?rate=44100&reset=1`, { method: 'POST' }))).status).toBe(204)
  expect(feed).toHaveBeenLastCalledWith({ bus: 2, sampleRate: 44100, samples: [], reset: true })
})

it('rejects stale bus capabilities, invalid audio and inactive native sessions', async () => {
  const feed = vi.fn(async () => true), transport = new ArsenalOutputTransport(feed), old = transport.open(0), url = transport.open(0)
  expect((await transport.response(request(old))).status).toBe(403)
  expect((await transport.response(request(url, [NaN, 0]))).status).toBe(400)
  expect((await transport.response(request(url, [1]))).status).toBe(400)
  expect((await transport.response(request(url, [], { headers: { 'Content-Length': '70000' } }))).status).toBe(413)
  expect((await transport.response(new Request(`${url}?rate=0`, { method: 'POST' }))).status).toBe(400)
  expect(feed).not.toHaveBeenCalled()
  feed.mockResolvedValue(false)
  expect((await transport.response(request(url))).status).toBe(409)
  expect((await transport.response(new Request(url, { method: 'OPTIONS' }))).status).toBe(204)
  expect(() => transport.open(8)).toThrow('INVALID_PCM_BUS')
})

it('rechecks ownership after reading a delayed request body', async () => {
  const feed = vi.fn(async () => true), transport = new ArsenalOutputTransport(feed), url = transport.open(1)
  let complete!: (data: ArrayBuffer) => void
  const delayed = request(url)
  delayed.arrayBuffer = () => new Promise(resolve => { complete = resolve })
  const response = transport.response(delayed)
  transport.open(1)
  complete(new Float32Array([.2, .2]).buffer)
  expect((await response).status).toBe(403)
  expect(feed).not.toHaveBeenCalled()
})
