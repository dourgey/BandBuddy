import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs'

/** Repairs only float WAV captures created by BandBuddy, including reserved RF64 headers. */
export function recoverFloatCapture(file: string): { durationMs: number; frames: number } {
  const fd = openSync(file, 'r+')
  try {
    const size = fstatSync(fd).size
    const header = Buffer.alloc(Math.min(size, 65536))
    readSync(fd, header, 0, header.length, 0)
    if (header.length < 44 || !['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('CAPTURE_HEADER_INVALID')
    let channels = 0, rate = 0, dataOffset = 0, reserve = 0
    for (let p = 12; p + 8 <= header.length;) {
      const id = header.toString('ascii', p, p + 4), length = header.readUInt32LE(p + 4)
      if (id === 'data') { dataOffset = p + 8; break }
      if (p + 8 + length > header.length) throw new Error('CAPTURE_HEADER_INVALID')
      if ((id === 'JUNK' || id === 'ds64') && length === 28) reserve = p
      if (id === 'fmt ' && length >= 16) {
        if (header.readUInt16LE(p + 8) !== 3 || header.readUInt16LE(p + 22) !== 32) throw new Error('CAPTURE_FORMAT_INVALID')
        channels = header.readUInt16LE(p + 10); rate = header.readUInt32LE(p + 12)
      }
      p += 8 + length + length % 2
    }
    if (!dataOffset || ![1, 2].includes(channels) || rate < 8000 || rate > 384000) throw new Error('CAPTURE_FORMAT_INVALID')
    const frames = Math.floor((size - dataOffset) / (4 * channels)), bytes = frames * 4 * channels
    const total = dataOffset + bytes, rf64 = total - 8 > 0xffffffff
    if (rf64 && !reserve) throw new Error('CAPTURE_RF64_RESERVATION_MISSING')
    header.write(rf64 ? 'RF64' : 'RIFF', 0, 'ascii')
    header.writeUInt32LE(rf64 ? 0xffffffff : total - 8, 4)
    header.writeUInt32LE(rf64 ? 0xffffffff : bytes, dataOffset - 4)
    if (reserve) {
      header.write(rf64 ? 'ds64' : 'JUNK', reserve, 'ascii')
      if (rf64) {
        header.writeBigUInt64LE(BigInt(total - 8), reserve + 8)
        header.writeBigUInt64LE(BigInt(bytes), reserve + 16)
        header.writeBigUInt64LE(BigInt(frames), reserve + 24)
        header.writeUInt32LE(0, reserve + 32)
      }
    }
    writeSync(fd, header, 0, dataOffset, 0)
    ftruncateSync(fd, total)
    return { durationMs: frames * 1000 / rate, frames }
  } finally { closeSync(fd) }
}
