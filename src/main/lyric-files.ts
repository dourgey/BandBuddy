import { inflateSync } from 'node:zlib'
import { decryptQrc } from 'qrc-decoder'

export const MAX_LYRICS_BYTES = 2 * 1024 * 1024
const KRC_KEY = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69])
// Fixed format mask used by local QRC files, not an application credential.
const QRC_MASK = Buffer.from('c34ad6ca9067f752d8a166629f5b0900c35e95239f13117ed8923fbc90bb740ec347743d90aa3f51d8f411849fde951dc3c609d59ffa66f9d8f0f7a090a1d6f3c3f3d6a190a0f7f0d8f966fa9fd509c6c31d95de9f8411f4d8513faa903d7447c30e74bb90bc3f92d87e11139f23955ec300095b9f6266a1d852f76790cad64a', 'hex')

function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0) return new TextDecoder('utf-16be').decode(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('gb18030').decode(bytes) }
}

export function decodeLyricFile(bytes: Buffer, extension: string): string {
  if (bytes.length > MAX_LYRICS_BYTES) throw new Error('LYRICS_FILE_TOO_LARGE')
  let text: string
  try {
    if (extension === '.krc' && bytes.subarray(0, 4).toString() === 'krc1') {
      const payload = Buffer.from(bytes.subarray(4))
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ KRC_KEY[i % KRC_KEY.length]!
      text = inflateSync(payload, { maxOutputLength: MAX_LYRICS_BYTES }).toString('utf8')
    } else if (extension === '.qrc') {
      const plain = decodeText(bytes).trim()
      if (/^(?:<|\[)/.test(plain)) text = plain
      else {
        let hex: string
        if (/^[\da-f\s]+$/i.test(plain) && plain.replace(/\s/g, '').length % 16 === 0) hex = plain.replace(/\s/g, '')
        else {
          const local = Buffer.from(bytes)
          for (let i = 0; i < local.length; i++) local[i] = local[i]! ^ QRC_MASK[(i > 0x7fff ? i % 0x7fff : i) & 0x7f]!
          hex = local.subarray(11).toString('hex')
        }
        text = decryptQrc(hex)
      }
    } else text = decodeText(bytes)
  } catch { throw new Error('LYRICS_DECODE_FAILED') }
  if (Buffer.byteLength(text) > MAX_LYRICS_BYTES) throw new Error('LYRICS_FILE_TOO_LARGE')
  return text
}
