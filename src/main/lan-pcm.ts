import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { LAN_PCM_FRAMES, LAN_PCM_RATE } from '@shared/lan.js'
import { spawnSafe } from './process.js'

export interface LanPcmSource { path: string; drums: boolean; gain: number }

/** Reads exact PCM frame boundaries without collecting the whole decoder output. */
class PipeReader {
  private wake: (() => void) | null = null
  constructor(private stream: Readable, private readonly exit: Promise<number>) {
    // A readable listener also prevents ChildProcess.flushStdio() from draining
    // short decoder outputs before the DSP has finished its startup handshake.
    const wake = (): void => { this.wake?.(); this.wake = null }
    stream.on('readable', wake); stream.on('end', wake); stream.on('error', wake); stream.on('close', wake)
  }
  async read(length: number, pad = false): Promise<Buffer> {
    const output = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const chunk = this.stream.read(Math.min(65536, length - offset)) as Buffer | null
      if (chunk) { chunk.copy(output, offset); offset += chunk.length; continue }
      if (this.stream.errored) throw this.stream.errored
      if (this.stream.readableEnded || this.stream.destroyed) {
        if (pad && await this.exit === 0) return output
        throw new Error('LAN_PCM_PIPE_CLOSED')
      }
      await new Promise<void>(resolve => { this.wake = resolve })
    }
    return output
  }
  async line(): Promise<string> {
    let value = ''
    while (value.length < 4096) {
      const byte = (await this.read(1))[0]!
      if (byte === 10) return value
      value += String.fromCharCode(byte)
    }
    throw new Error('LAN_PCM_INVALID_HEADER')
  }
}

/** One bounded decoder/DSP pair per remote session. Pulling drives both pipes. */
export class LanPcmRenderer {
  private controller = new AbortController()
  private decoder: ChildProcessWithoutNullStreams
  private dsp: ChildProcessWithoutNullStreams
  private decoded: PipeReader
  private rendered: PipeReader
  private produced = 0
  private consumed = 0
  private total: number
  private disposeParent: () => void
  private constructor(ffmpeg: string, executable: string, private sources: LanPcmSource[],
    private position: number, duration: number, private rate: number, pitch: number, signal: AbortSignal) {
    signal.throwIfAborted()
    this.disposeParent = () => this.dispose()
    signal.addEventListener('abort', this.disposeParent, { once: true })
    this.total = Math.max(0, Math.ceil((duration - position) * LAN_PCM_RATE / rate - 1e-7))
    const inputs = sources.flatMap(source => ['-ss', position.toFixed(9), '-i', source.path])
    const filters = sources.map((_, index) => `[${index}:a]aresample=${LAN_PCM_RATE},aformat=sample_fmts=flt:channel_layouts=stereo,apad,atrim=duration=${Math.max(.001, duration - position).toFixed(9)}[s${index}]`)
    filters.push(`${sources.map((_, index) => `[s${index}]`).join('')}${sources.length === 1 ? 'anull' : `amerge=inputs=${sources.length}`}[pcm]`)
    this.decoder = spawnSafe(ffmpeg, ['-nostdin', '-v', 'error', '-filter_complex_threads', '1', ...inputs,
      '-filter_complex', filters.join(';'), '-map', '[pcm]', '-threads', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { signal: this.controller.signal })
    this.dsp = spawnSafe(executable, ['--lan-pcm'], { signal: this.controller.signal })
    const reader = (child: ChildProcessWithoutNullStreams): PipeReader => {
      const exited = new Promise<number>(resolve => {
        child.once('error', error => { child.stdout.destroy(error); resolve(-1) })
        child.once('close', code => resolve(code ?? -1))
      })
      child.stdin.on('error', error => child.stdout.destroy(error))
      // Keep diagnostics bounded; never forward local paths to the browser.
      child.stderr.resume()
      return new PipeReader(child.stdout, exited)
    }
    this.decoded = reader(this.decoder); this.rendered = reader(this.dsp)
    this.dsp.stdin.write(JSON.stringify({ drums: sources.map(source => source.drums), rate, pitch }) + '\n')
    this.detach = () => signal.removeEventListener('abort', this.disposeParent)
  }
  private detach: () => void
  static async create(ffmpeg: string, executable: string, sources: LanPcmSource[], position: number, duration: number,
    rate: number, pitch: number, signal: AbortSignal): Promise<LanPcmRenderer> {
    if (!sources.length || sources.length > 16) throw new Error('LAN_PCM_TRACK_LIMIT')
    const renderer = new LanPcmRenderer(ffmpeg, executable, sources, position, duration, rate, pitch, signal)
    const timeout = setTimeout(() => renderer.dispose(), 15_000)
    try {
      const { primeFrames } = JSON.parse(await renderer.rendered.line())
      if (!Number.isInteger(primeFrames) || primeFrames < 0 || primeFrames > 32768) throw new Error('LAN_PCM_INVALID_PREROLL')
      if (primeFrames) await renderer.process(primeFrames, 0)
      signal.throwIfAborted()
      return renderer
    } catch (error) { renderer.dispose(); throw error }
    finally { clearTimeout(timeout) }
  }
  private async process(inputFrames: number, outputFrames: number): Promise<Buffer> {
    const input = await this.decoded.read(inputFrames * this.sources.length * 8, true)
    const header = Buffer.alloc(8 + this.sources.length * 4)
    header.writeUInt32LE(inputFrames, 0); header.writeUInt32LE(outputFrames, 4)
    this.sources.forEach((source, index) => header.writeFloatLE(source.gain, 8 + index * 4))
    await new Promise<void>((resolve, reject) => this.dsp.stdin.write(Buffer.concat([header, input]), error => error ? reject(error) : resolve()))
    return this.rendered.read(outputFrames * 8)
  }
  async next(): Promise<{ pcm: Buffer; position: number; frames: number; ended: boolean } | null> {
    const frames = Math.min(LAN_PCM_FRAMES, this.total - this.produced)
    if (frames <= 0) return null
    const target = Math.round((this.produced + frames) * this.rate)
    const inputFrames = target - this.consumed
    const pcm = await this.process(inputFrames, frames)
    const position = this.position + this.produced * this.rate / LAN_PCM_RATE
    this.consumed = target; this.produced += frames
    return { pcm, frames, position, ended: this.produced >= this.total }
  }
  setGains(gains: number[]): void {
    if (gains.length !== this.sources.length || gains.some(gain => !Number.isFinite(gain) || gain < 0 || gain > 64)) throw new Error('LAN_PCM_GAINS')
    this.sources.forEach((source, i) => { source.gain = gains[i]! })
  }
  dispose(): void { this.detach?.(); this.controller.abort() }
}
