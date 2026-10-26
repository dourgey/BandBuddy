import { randomUUID } from 'node:crypto'

type PcmPacket = { bus: number; sampleRate: number; samples: number[]; reset?: boolean }

/** A capability issued over trusted IPC lets the audio worker bypass the UI. */
export class ArsenalOutputTransport {
  private readonly tokens = new Map<number, string>()
  constructor(private readonly feed: (packet: PcmPacket) => Promise<boolean>) {}

  open(bus: number): string {
    if (!Number.isInteger(bus) || bus < 0 || bus > 7) throw new Error('INVALID_PCM_BUS')
    const token = randomUUID()
    this.tokens.set(bus, token)
    return `bandbuddy-media://arsenal-output/${bus}/${token}`
  }

  async response(request: Request): Promise<Response> {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }
    const reply = (status: number): Response => new Response(null, { status, headers })
    const url = new URL(request.url), [, busText, token] = url.pathname.split('/'), bus = Number(busText)
    const valid = (): boolean => Number.isInteger(bus) && !!token && this.tokens.get(bus) === token
    if (!valid()) return reply(403)
    if (request.method === 'OPTIONS') return reply(204)
    if (request.method !== 'POST') return reply(405)
    const sampleRate = Number(url.searchParams.get('rate'))
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return reply(400)
    if (Number(request.headers.get('Content-Length')) > 65536) return reply(413)
    try {
      const bytes = await request.arrayBuffer()
      if (!valid()) return reply(403) // A new renderer may have reclaimed this bus.
      if (bytes.byteLength > 65536 || bytes.byteLength % 8) return reply(400)
      const samples = Array.from(new Float32Array(bytes))
      if (samples.some(sample => !Number.isFinite(sample))) return reply(400)
      return reply(await this.feed({ bus, sampleRate, samples, reset: url.searchParams.get('reset') === '1' }) ? 204 : 409)
    } catch { return reply(503) }
  }
}
