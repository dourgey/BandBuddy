import type { Readable } from 'node:stream'

/** Bounded, frame-aligned reads; retain short outputs until their consumer is ready. */
export class AudioPipeReader {
  private wake: (() => void) | null = null
  constructor(private stream: Readable, private readonly exit: Promise<number>) {
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
        throw new Error('AUDIO_PCM_PIPE_CLOSED')
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
    throw new Error('AUDIO_PCM_INVALID_HEADER')
  }
}
