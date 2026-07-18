import { createDecipheriv } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'

const MAGIC = Buffer.from('CTENFDAM', 'ascii')
const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex')
const META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex')
const KEY_PREFIX = Buffer.from('neteasecloudmusic', 'ascii')
const META_PREFIX = Buffer.from("163 key(Don't modify):", 'ascii')
const MAX_KEY_BYTES = 1024 * 1024
const MAX_METADATA_BYTES = 16 * 1024 * 1024
const MAX_COVER_BYTES = 64 * 1024 * 1024

export interface NcmDecodedInfo {
  title: string | null
  artist: string | null
  album: string | null
  cover: Buffer | null
}

interface MetadataShape {
  musicName?: unknown
  artist?: unknown
  album?: unknown
  mainMusic?: unknown
}

function decryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error('INVALID_NCM_AES_BLOCK')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

function createKeyBox(key: Buffer): Uint8Array {
  if (key.length === 0) throw new Error('INVALID_NCM_KEY')
  const box = Uint8Array.from({ length: 256 }, (_, index) => index)
  let cursor = 0
  for (let index = 0; index < 256; index += 1) {
    cursor = (cursor + box[index]! + key[index % key.length]!) & 0xff
    const value = box[index]!
    box[index] = box[cursor]!
    box[cursor] = value
  }
  const keyBox = new Uint8Array(256)
  for (let index = 0; index < 256; index += 1) {
    const next = (index + 1) & 0xff
    const first = box[next]!
    const second = box[(first + next) & 0xff]!
    keyBox[index] = box[(second + first) & 0xff]!
  }
  return keyBox
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseMetadata(encrypted: Buffer): Omit<NcmDecodedInfo, 'cover'> {
  if (encrypted.length === 0) return { title: null, artist: null, album: null }
  for (let index = 0; index < encrypted.length; index += 1) encrypted[index] = encrypted[index]! ^ 0x63
  if (!encrypted.subarray(0, META_PREFIX.length).equals(META_PREFIX)) {
    return { title: null, artist: null, album: null }
  }
  try {
    const decoded = Buffer.from(encrypted.subarray(META_PREFIX.length).toString('ascii'), 'base64')
    const plain = decryptAesEcb(decoded, META_KEY)
    const separator = plain.indexOf(0x3a)
    if (separator < 0) return { title: null, artist: null, album: null }
    const root = JSON.parse(plain.subarray(separator + 1).toString('utf8')) as MetadataShape
    const metadata = root.mainMusic && typeof root.mainMusic === 'object'
      ? root.mainMusic as MetadataShape
      : root
    const artists = Array.isArray(metadata.artist)
      ? metadata.artist.flatMap((entry) => Array.isArray(entry) ? [text(entry[0])].filter((item): item is string => item !== null) : [])
      : []
    return { title: text(metadata.musicName), artist: artists.length ? artists.join('/') : null, album: text(metadata.album) }
  } catch {
    return { title: null, artist: null, album: null }
  }
}

export async function decodeNcmFile(input: string, output: string): Promise<NcmDecodedInfo> {
  const source = await open(input, 'r')
  const destination = await open(output, 'w').catch(async (error: unknown) => {
    await source.close()
    throw error
  })
  let complete = false
  try {
    const sourceInfo = await source.stat()
    let offset = 0
    const readExact = async (length: number): Promise<Buffer> => {
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > sourceInfo.size) throw new Error('INVALID_NCM_STRUCTURE')
      const data = Buffer.allocUnsafe(length)
      let position = 0
      while (position < length) {
        const result = await source.read(data, position, length - position, offset + position)
        if (result.bytesRead === 0) throw new Error('INVALID_NCM_STRUCTURE')
        position += result.bytesRead
      }
      offset += length
      return data
    }
    const readLength = async (maximum: number): Promise<number> => {
      const length = (await readExact(4)).readUInt32LE(0)
      if (length > maximum) throw new Error('INVALID_NCM_STRUCTURE')
      return length
    }

    if (!(await readExact(MAGIC.length)).equals(MAGIC)) throw new Error('INVALID_NCM_HEADER')
    await readExact(2)

    const encryptedKey = await readExact(await readLength(MAX_KEY_BYTES))
    for (let index = 0; index < encryptedKey.length; index += 1) encryptedKey[index] = encryptedKey[index]! ^ 0x64
    const decryptedKey = decryptAesEcb(encryptedKey, CORE_KEY)
    if (!decryptedKey.subarray(0, KEY_PREFIX.length).equals(KEY_PREFIX)) throw new Error('INVALID_NCM_KEY')
    const keyBox = createKeyBox(decryptedKey.subarray(KEY_PREFIX.length))

    const encryptedMetadata = await readExact(await readLength(MAX_METADATA_BYTES))
    const metadata = parseMetadata(encryptedMetadata)
    await readExact(5)
    const coverFrameLength = await readLength(MAX_COVER_BYTES)
    const coverLength = await readLength(MAX_COVER_BYTES)
    if (coverLength > coverFrameLength) throw new Error('INVALID_NCM_STRUCTURE')
    const cover = coverLength ? await readExact(coverLength) : null
    await readExact(coverFrameLength - coverLength)
    if (offset >= sourceInfo.size) throw new Error('EMPTY_NCM_AUDIO')

    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let audioPosition = 0
    while (offset < sourceInfo.size) {
      const wanted = Math.min(buffer.length, sourceInfo.size - offset)
      const result = await source.read(buffer, 0, wanted, offset)
      if (result.bytesRead === 0) throw new Error('INVALID_NCM_STRUCTURE')
      const chunk = buffer.subarray(0, result.bytesRead)
      for (let index = 0; index < chunk.length; index += 1) {
        chunk[index] = chunk[index]! ^ keyBox[(audioPosition + index) & 0xff]!
      }
      let written = 0
      while (written < chunk.length) {
        const result = await destination.write(chunk, written, chunk.length - written)
        if (result.bytesWritten === 0) throw new Error('NCM_OUTPUT_WRITE_FAILED')
        written += result.bytesWritten
      }
      offset += result.bytesRead
      audioPosition += result.bytesRead
    }
    complete = true
    return { ...metadata, cover }
  } finally {
    await Promise.allSettled([source.close(), destination.close()])
    if (!complete) await unlink(output).catch(() => undefined)
  }
}
