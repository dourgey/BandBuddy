import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { type BpmDetectionResult, type MediaCapabilities, type MusicalKeyAnalysis, type StemStorageFormat, type StemType } from '@shared/domain.js'
import { SOURCE_MEDIA_EXTENSIONS } from '@shared/media-formats.js'
import type { BpmAnalysis } from './bpm-detection.js'
import { runMediaAnalysis } from './media-analysis.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'
import { runProcess } from './process.js'
import type { Logger } from './logger.js'
import { mediaResponseHeaders, parseByteRange } from './media-range.js'
import { decodeNcmFile } from './ncm.js'
import { currentToolTarget, toolFile } from './platform-tools.js'
import { isTrustedMacBundleAsync } from './macos-bundle-integrity.js'
import { isTrustedWindowsTool } from './windows-tool-integrity.js'

export interface AudioProbe {
  durationMs: number
  sampleRate: number | null
  channels: number | null
  format: string | null
  title: string | null
  artist: string | null
  video: { codec: string | null; pixelFormat: string | null } | null
}

interface ProbeJson {
  streams?: Array<{
    codec_type?: string; codec_name?: string; pix_fmt?: string; sample_rate?: string; channels?: number
    disposition?: { attached_pic?: number }
  }>
  format?: { duration?: string; format_name?: string; tags?: Record<string, string> }
}

const mimeTypes: Record<string, string> = {
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
}

const TOOL_TARGET = currentToolTarget()
const FFMPEG_FILE_HASHES: Record<string, string> = Object.fromEntries(
  TOOL_TARGET.files
    .filter((file) => ['ffmpeg', 'ffprobe', 'ffmpegDependency'].includes(file.role))
    .map((file) => [file.output, file.sha256])
)

export class MediaService {
  private verifiedToolRoot: string | null = null
  private verification: Promise<void> | null = null

  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly logger: Logger
  ) {}

  ready(): Promise<void> {
    this.verification ??= this.findVerifiedToolRoot().then(root => {
      this.verifiedToolRoot = root
      if (!root) this.logger.error('FFmpeg resources failed integrity verification')
    })
    return this.verification
  }

  private async findVerifiedToolRoot(): Promise<string | null> {
    const candidates = [
      this.paths.packagedResource('bin'),
      path.join(process.cwd(), 'resources', 'bin')
    ]
    for (const root of [...new Set(candidates)]) {
      let valid = true
      for (const [name, expected] of Object.entries(FFMPEG_FILE_HASHES)) {
        try {
          const hash = createHash('sha256')
          for await (const chunk of createReadStream(path.join(root, name))) hash.update(chunk as Buffer)
          if (hash.digest('hex') !== expected) {
            if (root !== this.paths.packagedResource('bin') || !await isTrustedWindowsTool(path.join(root, name))) { valid = false; break }
          }
        } catch { valid = false; break }
      }
      if (valid) return root
      if (root === this.paths.packagedResource('bin')
        && Object.keys(FFMPEG_FILE_HASHES).every(name => existsSync(path.join(root, name)))
        && await isTrustedMacBundleAsync(path.dirname(root))) return root
    }
    return null
  }

  capabilities(): MediaCapabilities {
    return {
      ffmpegReady: this.verifiedToolRoot !== null,
      ffmpegVersion: TOOL_TARGET.ffmpegVersion,
      protocolVersion: 1,
      supportedInputFormats: [...SOURCE_MEDIA_EXTENSIONS].map((extension) => extension.slice(1)),
      supportedExportFormats: ['wav', 'flac', 'mp3'],
      internalSampleRate: 44100,
      internalChannels: 2,
      internalBitDepth: 24
    }
  }

  tool(name: 'ffmpeg' | 'ffprobe'): string | null {
    if (!this.verifiedToolRoot) return null
    return path.join(this.verifiedToolRoot, toolFile(TOOL_TARGET, name).output)
  }

  toolsReady(): boolean {
    return Boolean(this.tool('ffmpeg') && this.tool('ffprobe'))
  }

  async probe(filePath: string): Promise<AudioProbe> {
    await this.ready()
    const ffprobe = this.tool('ffprobe')
    if (!ffprobe) {
      return { durationMs: 0, sampleRate: null, channels: null, format: path.extname(filePath).slice(1), title: null, artist: null, video: null }
    }
    const result = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath])
    if (result.code !== 0) throw new Error(`AUDIO_PROBE_FAILED:${result.stderr.slice(-800)}`)
    const parsed = JSON.parse(result.stdout) as ProbeJson
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
    if (!audio) throw new Error('NO_AUDIO_STREAM')
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    const tags = parsed.format?.tags ?? {}
    const durationSeconds = Number(parsed.format?.duration ?? 0)
    return {
      durationMs: Number.isFinite(durationSeconds) ? Math.max(0, Math.round(durationSeconds * 1000)) : 0,
      sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio.channels ?? null,
      format: parsed.format?.format_name?.split(',')[0] ?? path.extname(filePath).slice(1),
      title: tags.title ?? tags.TITLE ?? null,
      artist: tags.artist ?? tags.ARTIST ?? null,
      video: video ? { codec: video.codec_name ?? null, pixelFormat: video.pix_fmt ?? null } : null
    }
  }

  async decodeAudio(input: string, temporaryOutput: string, finalOutput: string, signal: AbortSignal): Promise<void> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    mkdirSync(path.dirname(temporaryOutput), { recursive: true })
    try {
      // Decode every input format before Python inference. Float PCM preserves
      // decoded peaks above 0 dBFS and avoids an intermediate lossy encoding.
      const result = await runProcess(ffmpeg, [
        '-y', '-v', 'error', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-map_metadata', '-1', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le',
        '-f', 'wav', temporaryOutput
      ], { signal })
      if (signal.aborted) throw new Error('JOB_CANCELLED')
      if (result.code !== 0) throw new Error(`AUDIO_DECODE_FAILED:${result.stderr.slice(-800)}`)
      await rename(temporaryOutput, finalOutput)
    } finally {
      await unlink(temporaryOutput).catch(() => undefined)
    }
  }

  async extractVideoAudio(input: string, temporaryOutput: string, finalOutput: string, signal: AbortSignal): Promise<void> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    const probe = await this.probe(input)
    if (!probe.video) throw new Error('NO_VIDEO_STREAM')
    if (probe.durationMs <= 0) throw new Error('INVALID_VIDEO_DURATION')
    mkdirSync(path.dirname(temporaryOutput), { recursive: true })
    try {
      // Use the container timeline for both audio and video. first_pts pads a
      // delayed audio stream instead of moving it ahead of the picture.
      const result = await runProcess(ffmpeg, [
        '-y', '-v', 'error', '-copyts', '-start_at_zero', '-i', input,
        '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-af', `aresample=async=1:first_pts=0,apad=whole_dur=${(probe.durationMs / 1000).toFixed(3)}`,
        '-t', (probe.durationMs / 1000).toFixed(3), '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', temporaryOutput
      ], { signal })
      if (signal.aborted) throw new Error('JOB_CANCELLED')
      if (result.code !== 0) throw new Error(`VIDEO_AUDIO_EXTRACTION_FAILED:${result.stderr.slice(-800)}`)
      await rename(temporaryOutput, finalOutput)
    } finally {
      await unlink(temporaryOutput).catch(() => undefined)
    }
  }

  async prepareVideo(input: string, temporaryRoot: string, outputRoot: string, signal: AbortSignal): Promise<string> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    if (signal.aborted) throw new Error('JOB_CANCELLED')
    const { video } = await this.probe(input)
    if (!video) throw new Error('NO_VIDEO_STREAM')
    const copyH264 = video.codec === 'h264' && ['yuv420p', 'yuvj420p'].includes(video.pixelFormat ?? '')
    const copyWebm = ['vp8', 'vp9'].includes(video.codec ?? '')
    const extension = copyH264 ? 'mp4' : 'webm'
    const temporaryOutput = path.join(temporaryRoot, `playback.part.${extension}`)
    const finalOutput = path.join(outputRoot, `playback.${extension}`)
    mkdirSync(temporaryRoot, { recursive: true })
    mkdirSync(outputRoot, { recursive: true })
    try {
      const result = await runProcess(ffmpeg, [
        '-y', '-v', 'error', '-copyts', '-start_at_zero', '-i', input,
        '-map', '0:V:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
        ...(copyH264 || copyWebm
          ? ['-c:v', 'copy']
          : ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p']),
        ...(copyH264 ? ['-movflags', '+faststart'] : []),
        temporaryOutput
      ], { signal })
      if (signal.aborted) throw new Error('JOB_CANCELLED')
      if (result.code !== 0) throw new Error(`VIDEO_PREPARATION_FAILED:${result.stderr.slice(-800)}`)
      await rename(temporaryOutput, finalOutput)
      return finalOutput
    } finally {
      await unlink(temporaryOutput).catch(() => undefined)
    }
  }

  async extractArtwork(input: string, output: string): Promise<boolean> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) return false
    mkdirSync(path.dirname(output), { recursive: true })
    const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', input, '-an', '-frames:v', '1', '-c:v', 'mjpeg', output])
    return result.code === 0 && existsSync(output)
  }

  async convertNcmToMp3(input: string, decrypted: string, temporaryOutput: string, finalOutput: string): Promise<void> {
    await this.ready()
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
    await this.ready()
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

  async normalize(
    input: string,
    temporaryOutput: string,
    finalOutput: string,
    targetDurationMs?: number,
    storageFormat: StemStorageFormat = 'flac24',
    linearGain = 1
  ): Promise<AudioProbe> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    mkdirSync(path.dirname(temporaryOutput), { recursive: true })
    if (!Number.isFinite(linearGain) || linearGain <= 0 || linearGain > 1) throw new Error('INVALID_STEM_ENCODING_GAIN')
    const filters = linearGain < 1 ? [`volume=${linearGain.toFixed(12)}`] : []
    const durationSeconds = targetDurationMs && targetDurationMs > 0
      ? (targetDurationMs / 1000).toFixed(3)
      : null
    if (durationSeconds) filters.push(`apad=whole_dur=${durationSeconds}`)
    const filterArgs = filters.length > 0 ? ['-af', filters.join(',')] : []
    const durationArgs = durationSeconds ? ['-t', durationSeconds] : []
    const codecArgs = storageFormat === 'flac24'
      ? ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24']
      : ['-c:a', 'libmp3lame', '-b:a', '320k']
    const result = await runProcess(ffmpeg, [
      '-y', '-v', 'error', '-i', input, '-map_metadata', '-1', '-vn', ...filterArgs, ...durationArgs, '-ar', '44100', '-ac', '2',
      ...codecArgs, temporaryOutput
    ])
    if (result.code !== 0) throw new Error(`NORMALIZE_FAILED:${result.stderr.slice(-800)}`)
    await rename(temporaryOutput, finalOutput)
    return await this.probe(finalOutput)
  }

  async generatePeaks(input: string, output: string, durationMs: number, bins = 1800, signal?: AbortSignal): Promise<void> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) {
      await writeFile(output, JSON.stringify({ version: 1, sampleRate: 44100, min: [], max: [] }), 'utf8')
      return
    }
    mkdirSync(path.dirname(output), { recursive: true })
    const peaks = await runMediaAnalysis({
      kind: 'peaks', ffmpeg, durationMs, bins, sampleRate: 44100,
      args: ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1']
    }, signal)
    await writeFile(output, JSON.stringify(peaks), 'utf8')
  }

  async detectBpm(songId: string): Promise<BpmDetectionResult> {
    await this.ready()
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
    return await runMediaAnalysis({ kind: 'bpm', ffmpeg, sampleRate,
      args: ['-v', 'error', '-i', input, '-t', '180', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1']
    })
  }

  async detectKey(songId: string): Promise<MusicalKeyAnalysis> {
    await this.ready()
    const ffmpeg = this.tool('ffmpeg')
    if (!ffmpeg) throw new Error('FFMPEG_MISSING')
    const song = this.database.getSong(songId)
    if (!song) throw new Error('SONG_NOT_FOUND')
    const preference: StemType[] = ['bass', 'guitar', 'piano', 'other', 'vocals']
    const stems = preference
      .map((type) => song.stems.find((candidate) => candidate.type === type))
      .filter((stem): stem is NonNullable<typeof stem> => Boolean(stem))
    if (!stems.length) throw new Error('KEY_DETECTION_NO_AUDIO')
    const inputs = stems.map((stem) => ({ stem, path: this.resolveProtocolPath(new URL(stem.mediaUrl)) }))
      .filter((entry): entry is { stem: (typeof stems)[number]; path: string } => Boolean(entry.path))
    if (!inputs.length) throw new Error('KEY_DETECTION_NO_AUDIO')

    const sampleRate = 11_025
    const labels = inputs.map((_, index) => `[${index}:a]`).join('')
    const filter = inputs.length === 1
      ? '[0:a]anull[keymix]'
      : `${labels}amix=inputs=${inputs.length}:duration=longest:normalize=1[keymix]`
    const analysis = await runMediaAnalysis({ kind: 'key', ffmpeg, sampleRate,
      stems: inputs.map(({ stem }) => stem.type),
      args: [
        '-v', 'error', ...inputs.flatMap((input) => ['-i', input.path]),
        '-filter_complex', filter, '-map', '[keymix]', '-t', '300', '-vn',
        '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'
      ]
    })
    if (!analysis) throw new Error('KEY_DETECTION_UNSTABLE')
    const saved = this.database.saveKeyAnalysis(songId, analysis)
    this.logger.info('musical key detected and saved', {
      songId,
      key: analysis.label,
      confidence: analysis.confidence,
      analyzedStems: analysis.analyzedStems,
      possibleModulations: analysis.segments.filter((segment) => segment.possibleModulation).length,
      preservedManualKey: saved.musicalKeySource === 'manual'
    })
    return analysis
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

  resolveProtocolPath(url: URL): string | null {
    if (url.hostname === 'rehearsal') {
      const [rehearsalId, kind, assetId] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (!rehearsalId || !assetId || !/^[0-9a-f-]{36}$/i.test(rehearsalId) || !/^[0-9a-f-]{36}$/i.test(assetId)) return null
      const take = this.database.getRehearsalRecordingTakeFile(assetId)
      if (!take || take.rehearsalId !== rehearsalId) return null
      const relative = kind === 'recording-source' ? take.sourceRelPath
        : kind === 'recording-preview' ? take.previewRelPath
          : null
      return relative ? this.paths.resolveLibraryPath(this.database.getSettings().libraryRoot, relative) : null
    }
    if (url.hostname !== 'song') return null
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const [songId, kind, assetId] = parts
    if (!songId || !/^[0-9a-f-]{36}$/i.test(songId) || !kind) return null
    const settings = this.database.getSettings()
    if (kind === 'video' && parts.length === 2) {
      const relative = this.database.getVideoRelative(songId)
      return relative ? this.paths.resolveLibraryPath(settings.libraryRoot, relative) : null
    }
    if (kind === 'artwork') {
      const relative = this.database.getArtworkRelative(songId)
      return relative ? this.paths.resolveLibraryPath(settings.libraryRoot, relative) : null
    }
    if (!assetId || !/^[0-9a-f-]{36}$/i.test(assetId)) return null
    if (kind.startsWith('recording-')) {
      const take = this.database.getRecordingTakeFile(assetId)
      if (!take || take.songId !== songId) return null
      const relative = kind === 'recording-source' ? take.sourceRelPath
        : kind === 'recording-preview' ? take.previewRelPath
          : kind === 'recording-peaks' ? take.peaksRelPath : null
      return relative ? this.paths.resolveLibraryPath(settings.libraryRoot, relative) : null
    }
    const stem = this.database.getStemAsset(songId, assetId)
    if (!stem) return null
    const relative = kind === 'stem' ? stem.relPath : kind === 'peaks' ? stem.peaksRelPath : null
    return relative ? this.paths.resolveLibraryPath(settings.libraryRoot, relative) : null
  }
}
