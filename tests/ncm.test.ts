import { createCipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeNcmFile } from '../src/main/ncm.js'
import { AUDIO_EXTENSIONS, SOURCE_AUDIO_EXTENSIONS } from '../src/main/imports.js'
import { MediaService } from '../src/main/media.js'

const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex')
const META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex')
const directories: string[] = []

function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function keyBox(key: Buffer): Uint8Array {
  const box = Uint8Array.from({ length: 256 }, (_, index) => index)
  let cursor = 0
  for (let index = 0; index < 256; index += 1) {
    cursor = (cursor + box[index]! + key[index % key.length]!) & 0xff
    ;[box[index], box[cursor]] = [box[cursor]!, box[index]!]
  }
  return Uint8Array.from({ length: 256 }, (_, index) => {
    const next = (index + 1) & 0xff
    const first = box[next]!
    return box[(box[(first + next) & 0xff]! + first) & 0xff]!
  })
}

function length(value: number): Buffer {
  const output = Buffer.alloc(4)
  output.writeUInt32LE(value)
  return output
}

function makeNcm(audio: Buffer, metadata: object, cover = Buffer.alloc(0), coverPadding = 0): Buffer {
  const streamKey = Buffer.from('test-stream-key')
  const encryptedKey = encryptAesEcb(Buffer.concat([Buffer.from('neteasecloudmusic'), streamKey]), CORE_KEY)
  for (let index = 0; index < encryptedKey.length; index += 1) encryptedKey[index] = encryptedKey[index]! ^ 0x64
  const encryptedMetadataPayload = encryptAesEcb(Buffer.from(`music:${JSON.stringify(metadata)}`), META_KEY).toString('base64')
  const encryptedMetadata = Buffer.from(`163 key(Don't modify):${encryptedMetadataPayload}`, 'ascii')
  for (let index = 0; index < encryptedMetadata.length; index += 1) encryptedMetadata[index] = encryptedMetadata[index]! ^ 0x63
  const encryptedAudio = Buffer.from(audio)
  const box = keyBox(streamKey)
  for (let index = 0; index < encryptedAudio.length; index += 1) encryptedAudio[index] = encryptedAudio[index]! ^ box[index & 0xff]!
  return Buffer.concat([
    Buffer.from('CTENFDAM'), Buffer.alloc(2), length(encryptedKey.length), encryptedKey,
    length(encryptedMetadata.length), encryptedMetadata, Buffer.alloc(5), length(cover.length + coverPadding),
    length(cover.length), cover, Buffer.alloc(coverPadding), encryptedAudio
  ])
}

function makeWav(): Buffer {
  const sampleRate = 8000
  const sampleCount = 1600
  const dataLength = sampleCount * 2
  const output = Buffer.alloc(44 + dataLength)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + dataLength, 4)
  output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(dataLength, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    output.writeInt16LE(Math.round(Math.sin(index / 12) * 4000), 44 + index * 2)
  }
  return output
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('source decoding', () => {
  it('restores audio bytes and reads embedded tags', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-source-'))
    directories.push(directory)
    const input = path.join(directory, 'input.ncm')
    const output = path.join(directory, 'output.audio')
    const audio = Buffer.from('ID3\x04\x00\x00synthetic audio payload', 'binary')
    await writeFile(input, makeNcm(
      audio,
      { musicName: 'Test Song', artist: [['Artist One', 1], ['Artist Two', 2]], album: 'Test Album' },
      Buffer.alloc(0),
      3
    ))

    const info = await decodeNcmFile(input, output)

    expect(await readFile(output)).toEqual(audio)
    expect(info).toMatchObject({ title: 'Test Song', artist: 'Artist One/Artist Two', album: 'Test Album', cover: null })
  })

  it('accepts the additional source extension without allowing it for stem imports', () => {
    expect(SOURCE_AUDIO_EXTENSIONS.has('.ncm')).toBe(true)
    expect(AUDIO_EXTENSIONS.has('.ncm')).toBe(false)
  })

  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  it.skipIf(!existsSync(path.join(process.cwd(), 'resources', 'bin', ffmpegName)))('creates a playable 320 kbps MP3', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-convert-'))
    directories.push(directory)
    const input = path.join(directory, 'input.ncm')
    const decrypted = path.join(directory, 'decoded.part')
    const temporary = path.join(directory, 'output.part.mp3')
    const output = path.join(directory, 'output.mp3')
    await writeFile(input, makeNcm(makeWav(), { musicName: 'Converted Song', artist: [['Test Artist', 1]], album: 'Test Album' }))
    const media = new MediaService(
      { packagedResource: () => path.join(directory, 'missing') } as never,
      {} as never,
      { error: () => undefined } as never
    )

    await media.convertNcmToMp3(input, decrypted, temporary, output)
    const probe = await media.probe(output)

    expect(probe).toMatchObject({ format: 'mp3', title: 'Converted Song', artist: 'Test Artist' })
    expect(probe.durationMs).toBeGreaterThan(0)
    expect(existsSync(decrypted)).toBe(false)
    expect(existsSync(temporary)).toBe(false)
  })
})
