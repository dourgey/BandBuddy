import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { type BpmDetectionResult, type MediaCapabilities, type StemType } from '@shared/domain.js'
import toolManifest from '../../resources/tool-manifest.json' with { type: 'json' }
import { detectBpmFromSamples, type BpmAnalysis } from './bpm-detection.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'
import { runProcess, spawnSafe } from './process.js'
import type { Logger } from './logger.js'
import { mediaResponseHeaders, parseByteRange } from './media-range.js'
import { decodeNcmFile } from './ncm.js'

export interface AudioProbe {
  durationMs: number
  sampleRate: number | null
  channels: number | null
  format: string | null
  title: string | null
  artist: string | null
}

interface ProbeJson {
  streams?: Array<{ codec_type?: string; sample_rate?: string; channels?: number }>
  format?: { duration?: string; format_name?: string; tags?: Record<string, string> }
}

const mimeTypes: Record<string, string> = {
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
}

const FFMPEG_FILE_HASHES: Record<string, string> = Object.fromEntries(
  toolManifest.files
    .filter((file) => file.archive === 'ffmpeg' && /\.(?:exe|dll)$/i.test(file.output))
    .map((file) => [file.output, file.sha256])
)

export class MediaService {
  private readonly verifiedToolRoot: string | null

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly logger: Logger
  ) {
    this.verifiedToolRoot = this.findVerifiedToolRoot()
    if (!this.verifiedToolRoot) this.logger.error('FFmpeg resources failed integrity verification')
  }

  private findVerifiedToolRoot(): string | null {
    const candidates = [
      this.paths.packagedResource('bin'),
      path.join(process.cwd(), 'resources', 'bin')
    ]
    for (const root of [...new Set(candidates)]) {
      const valid = Object.entries(FFMPEG_FILE_HASHES).every(([name, expected]) => {
        const file = path.join(root, name)
        if (!existsSync(file)) return false
        return createHash('sha256').update(readFileSync(file)).digest('hex') === expected
      })
      if (valid) return root
    }
    return null
  }

  capabilities(): MediaCapabilities {
    return {
      ffmpegReady: this.verifiedToolRoot !== null,
      ffmpegVersion: '8.1.2',
      protocolVersion: 1,
      supportedInputFormats: ['mp3', 'wav', 'flac', 'm4a', 'aac'],
      supportedExportFormats: ['wav', 'flac', 'mp3'],
      internalSampleRate: 44100,
      internalChannels: 2,
      internalBitDepth: 24
    }
  }

  tool(name: 'ffmpeg' | 'ffprobe'): string | null {
    if (!this.verifiedToolRoot) return null
    return path.join(this.verifiedToolRoot, `${name}.exe`)
  }

  toolsReady(): boolean {
    return Boolean(this.tool('ffmpeg') && this.tool('ffprobe'))
  }

  async probe(filePath: string): Promise<AudioProbe> {
    const ffprobe = this.tool('ffprobe')
    if (!ffprobe) {
      return { durationMs: 0, sampleRate: null, channels: null, format: path.extname(filePath).slice(1), title: null, artist: null }
    }
    const result = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath])
    if (result.code !== 0) throw new Error(`AUDIO_PROBE_FAILED:${result.stderr.slice(-800)}`)
    const parsed = JSON.parse(result.stdout) as ProbeJson
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
    if (!audio) throw new Error('NO_AUDIO_STREAM')
    const tags = parsed.format?.tags ?? {}
    return {
      durationMs: Math.max(0, Math.round(Number(parsed.format?.duration ?? 0) * 1000)),
      sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio.channels ?? null,
      format: parsed.format?.format_name?.split(',')[0] ?? path.extname(filePath).slice(1),
      title: tags.title ?? tags.TITLE ?? null,
      artist: tags.artist ?? tags.ARTIST ?? null
    }
  }

  async extractArtwork(input: string, output: string): Promise<boolean> {
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) return false
    mkdirSync(path.dirname(output), { recursive: true })
    const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', input, '-an', '-frames:v', '1', '-c:v', 'mjpeg', output])
    return result.code === 0 && existsSync(output)
  }

  async convertNcmToMp3(input: string, decrypted: string, temporaryOutput: string, finalOutput: string): Promise<void> {
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    let coverPath: string | null = null
    try {
      const metadata = await decodeNcmFile(input, decrypted)
      const inputArgs = ['-i', decrypted]
      const mapArgs = ['-map', '0:a:0', '-vn']
      if (metadata.cover?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        coverPath = `${decrypted}.jpg`
      } else if (metadata.cover?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        coverPath = `${decrypted}.png`
      }
      if (coverPath && metadata.cover) {
        await writeFile(coverPath, metadata.cover)
        inputArgs.push('-i', coverPath)
        mapArgs.splice(2, 1, '-map', '1:v:0', '-c:v', 'copy', '-disposition:v', 'attached_pic')
      }
      const metadataArgs = [
        ...(metadata.title ? ['-metadata', `title=${metadata.title}`] : []),
        ...(metadata.artist ? ['-metadata', `artist=${metadata.artist}`] : []),
        ...(metadata.album ? ['-metadata', `album=${metadata.album}`] : [])
      ]
      const result = await runProcess(ffmpeg, [
        '-y', '-v', 'error', ...inputArgs, ...mapArgs, '-map_metadata', '-1', ...metadataArgs,
        '-c:a', 'libmp3lame', '-b:a', '320k', temporaryOutput
      ])
      if (result.code !== 0) throw new Error(`AUDIO_CONVERSION_FAILED:${result.stderr.slice(-800)}`)
      await rename(temporaryOutput, finalOutput)
    } finally {
      await Promise.allSettled([
        unlink(decrypted),
        unlink(temporaryOutput),
        ...(coverPath ? [unlink(coverPath)] : [])
      ])
    }
  }

  async leadingSilenceMs(input: string): Promise<number | null> {
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) return null
    const sink = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const result = await runProcess(ffmpeg, [
      '-v', 'info', '-i', input, '-vn', '-af', 'silencedetect=noise=-50dB:d=0.25', '-f', 'null', sink
    ])
    if (result.code !== 0) return null
    const beganAtStart = /silence_start:\s*-?0(?:\.0+)?(?:\s|$)/.test(result.stderr)
    if (!beganAtStart) return 0
    const end = /silence_end:\s*([0-9.]+)/.exec(result.stderr)
    return end ? Math.max(0, Math.round(Number(end[1]) * 1000)) : null
  }

  async normalize(input: string, temporaryOutput: string, finalOutput: string, targetDurationMs?: number): Promise<AudioProbe> {
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    mkdirSync(path.dirname(temporaryOutput), { recursive: true })
    const durationArgs = targetDurationMs && targetDurationMs > 0
      ? ['-af', `apad=whole_dur=${(targetDurationMs / 1000).toFixed(3)}`, '-t', (targetDurationMs / 1000).toFixed(3)] : []
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', '-i', input, '-map_metadata', '-1', '-vn', ...durationArgs, '-ar', '44100', '-ac', '2',
      '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', temporaryOutput
    ])
    if (result.code !== 0) throw new Error(`NORMALIZE_FAILED:${result.stderr.slice(-800)}`)
    await rename(temporaryOutput, finalOutput)
    return await this.probe(finalOutput)
  }

  async generatePeaks(input: string, output: string, durationMs: number, bins = 1800): Promise<void> {
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) {
      await writeFile(output, JSON.stringify({ version: 1, sampleRate: 44100, min: [], max: [] }), 'utf8')
      return
    }
    mkdirSync(path.dirname(output), { recursive: true })
    const sampleCount = Math.max(1, Math.round(durationMs * 44.1))
    const samplesPerBin = Math.max(1, Math.ceil(sampleCount / bins))
    const min = new Float32Array(bins).fill(1)
    const max = new Float32Array(bins).fill(-1)
    let sampleIndex = 0
    let pending = Buffer.alloc(0)
    const child = spawnSafe(ffmpeg, ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'])
    const errorChunks: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk))
    child.stdout.on('data', (chunk: Buffer) => {
      const data = Buffer.concat([pending, chunk])
      const complete = data.length - (data.length % 4)
      for (let offset = 0; offset < complete; offset += 4) {
        const value = data.readFloatLE(offset)
        const bin = Math.min(bins - 1, Math.floor(sampleIndex / samplesPerBin))
        if (value < min[bin]!) min[bin] = value
        if (value > max[bin]!) max[bin] = value
        sampleIndex += 1
      }
      pending = data.subarray(complete)
    })
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (value) => resolve(value ?? -1))
    })
    if (code !== 0) throw new Error(`PEAKS_FAILED:${Buffer.concat(errorChunks).toString('utf8').slice(-800)}`)
    const normalizedMin = Array.from(min, (value, index) => max[index] === -1 ? 0 : Math.round(value * 32767))
    const normalizedMax = Array.from(max, (value) => value === -1 ? 0 : Math.round(value * 32767))
    await writeFile(output, JSON.stringify({ version: 1, sampleRate: 44100, min: normalizedMin, max: normalizedMax }), 'utf8')
  }

  async detectBpm(songId: string): Promise<BpmDetectionResult> {
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const song = this.database.getSong(songId)
    if (!song) throw new Error('SONG_NOT_FOUND')
    const preference: StemType[] = ['drums', 'bass', 'other', 'guitar', 'piano', 'vocals']
    const stems = preference
      .map((type) => song.stems.find((candidate) => candidate.type === type))
      .filter((stem): stem is NonNullable<typeof stem> => Boolean(stem))
      .slice(0, 3)
    if (!stems.length) throw new Error('BPM_DETECTION_NO_AUDIO')

    const results: Array<{ stem: StemType; analysis: BpmAnalysis }> = []
    let decodeError = ''
    for (const stem of stems) {
      const input = this.resolveProtocolPath(new URL(stem.mediaUrl))
      if (!input) continue
      try {
        const analysis = await this.analyzeBpmInput(ffmpeg, input)
        if (analysis) results.push({ stem: stem.type, analysis })
      } catch (error) {
        decodeError = String(error)
        this.logger.warn('BPM stem analysis failed', { songId, stem: stem.type, error: decodeError.slice(-500) })
      }
    }
    if (!results.length) {
      if (decodeError) throw new Error(`BPM_DETECTION_DECODE_FAILED:${decodeError.slice(-500)}`)
      throw new Error('BPM_DETECTION_UNSTABLE')
    }

    const ranked = results.map((result) => {
      const supporters = results.filter((candidate) => Math.abs(candidate.analysis.bpm - result.analysis.bpm) / result.analysis.bpm <= 0.018)
      return { ...result, supporters, rank: result.analysis.confidence + (supporters.length - 1) * 0.1 }
    }).sort((left, right) => right.rank - left.rank)
    const selected = ranked[0]!
    const totalWeight = selected.supporters.reduce((sum, result) => sum + Math.max(0.05, result.analysis.confidence ** 2), 0)
    const bpm = Math.round(selected.supporters.reduce((sum, result) => sum + result.analysis.bpm * Math.max(0.05, result.analysis.confidence ** 2), 0) / totalWeight * 10) / 10
    const beatDurationMs = 60_000 / bpm
    const phaseVector = selected.supporters.reduce((vector, result) => {
      const angle = result.analysis.beatOffsetMs / beatDurationMs * Math.PI * 2
      const weight = Math.max(0.05, result.analysis.confidence ** 2)
      return { x: vector.x + Math.cos(angle) * weight, y: vector.y + Math.sin(angle) * weight }
    }, { x: 0, y: 0 })
    const beatOffsetMs = Math.round(Math.atan2(phaseVector.y, phaseVector.x) / (Math.PI * 2) * beatDurationMs)
    const confidence = Math.min(1, selected.analysis.confidence + (selected.supporters.length - 1) * 0.07)
    this.database.updateSong(songId, { bpm, beatOffsetMs })
    this.logger.info('BPM and beat grid detected and saved', { songId, stem: selected.stem, bpm, beatOffsetMs, confidence, analyzedStems: results.map((result) => result.stem) })
    return { bpm, beatOffsetMs, confidence, analyzedStem: selected.stem }
  }

  private async analyzeBpmInput(ffmpeg: string, input: string): Promise<BpmAnalysis | null> {
    const sampleRate = 8000
    const child = spawnSafe(ffmpeg, [
      '-v', 'error', '-i', input, '-t', '180', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'
    ])
    const outputChunks: Buffer[] = []
    const errorChunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => outputChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk))
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (value) => resolve(value ?? -1))
    })
    if (code !== 0) throw new Error(Buffer.concat(errorChunks).toString('utf8').slice(-500))
    const pcm = Buffer.concat(outputChunks)
    const samples = new Float32Array(Math.floor(pcm.length / 4))
    for (let index = 0; index < samples.length; index += 1) samples[index] = pcm.readFloatLE(index * 4)
    return detectBpmFromSamples(samples, sampleRate)
  }

  registerProtocol(): void {
    protocol.handle('bandbuddy-media', async (request) => {
      try {
        const assetPath = this.resolveProtocolPath(new URL(request.url))
        if (!assetPath) return new Response('Not found', { status: 404 })
        const info = await stat(assetPath)
        const contentType = mimeTypes[path.extname(assetPath).toLowerCase()] ?? 'application/octet-stream'
        const headers = mediaResponseHeaders(contentType, info.size)
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers })
        const range = request.headers.get('range')
        if (!range) {
          return new Response(Readable.toWeb(createReadStream(assetPath)) as BodyInit, {
            status: 200,
            headers
          })
        }
        const parsedRange = parseByteRange(range, info.size)
        if (!parsedRange) return new Response('Range not satisfiable', { status: 416 })
        const { start, end } = parsedRange
        return new Response(Readable.toWeb(createReadStream(assetPath, { start, end })) as BodyInit, {
          status: 206,
          headers: {
            ...mediaResponseHeaders(contentType, end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
          }
        })
      } catch (error) {
        this.logger.warn('media protocol request rejected', error)
        return new Response('Not found', { status: 404 })
      }
    })
  }

  private resolveProtocolPath(url: URL): string | null {
    if (url.hostname !== 'song') return null
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const [songId, kind, assetId] = parts
    if (!songId || !/^[0-9a-f-]{36}$/i.test(songId) || !kind) return null
    const settings = this.database.getSettings()
    if (kind === 'artwork') {
      const relative = this.database.getArtworkRelative(songId)
      return relative ? this.paths.resolveLibraryPath(settings.libraryRoot, relative) : null
    }
    if (!assetId || !/^[0-9a-f-]{36}$/i.test(assetId)) return null
    const stem = this.database.getStemAsset(songId, assetId)
    if (!stem) return null
    const relative = kind === 'stem' ? stem.relPath : kind === 'peaks' ? stem.peaksRelPath : null
    return relative ? this.paths.resolveLibraryPath(settings.libraryRoot, relative) : null
  }
}
