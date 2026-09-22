import { parentPort, workerData } from 'node:worker_threads'
import { detectBpmFromSamples } from './bpm-detection.js'
import { detectMusicalKeyFromSamples } from './key-detection.js'
import { spawnSafe } from './process.js'
import type { MediaAnalysisRequest, PeaksAnalysis } from './media-analysis.js'

async function analyze(request: MediaAnalysisRequest): Promise<unknown> {
  const controller = new AbortController()
  parentPort?.on('message', message => { if (message?.cancel) controller.abort() })
  const bins = Math.max(1, Math.min(100_000, request.bins ?? 1800))
  const samplesPerBin = Math.max(1, Math.ceil(Math.max(1, (request.durationMs ?? 0) * request.sampleRate / 1000) / bins))
  const min = new Float32Array(bins).fill(1)
  const max = new Float32Array(bins).fill(-1)
  let sampleIndex = 0
  let pending: Buffer = Buffer.alloc(0)
  let stderr = ''
  let bytes = 0
  const chunks: Buffer[] = []
  const child = spawnSafe(request.ffmpeg, request.args, { timeoutMs: 19 * 60_000, signal: controller.signal })
  if (child.pid) parentPort?.postMessage({ pid: child.pid })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
  let decodeError: Error | null = null
  child.stdout.on('data', (chunk: Buffer) => {
    if (decodeError) return
    if (request.kind !== 'peaks') {
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) { decodeError = new Error('MEDIA_ANALYSIS_INPUT_TOO_LARGE'); child.kill(); return }
      chunks.push(chunk)
      return
    }
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const complete = data.length - data.length % 4
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
    child.once('close', value => resolve(value ?? -1))
  })
  parentPort?.postMessage({ childExited: true })
  if (decodeError) throw decodeError
  if (code !== 0) throw new Error(`MEDIA_ANALYSIS_DECODE_FAILED:${stderr.slice(-800)}`)
  if (request.kind === 'peaks') {
    return {
      version: 1, sampleRate: request.sampleRate,
      min: Array.from(min, (value, index) => max[index] === -1 ? 0 : Math.round(value * 32767)),
      max: Array.from(max, value => value === -1 ? 0 : Math.round(value * 32767))
    } satisfies PeaksAnalysis
  }
  const pcm = Buffer.concat(chunks)
  const samples = new Float32Array(Math.floor(pcm.length / 4))
  for (let index = 0; index < samples.length; index += 1) samples[index] = pcm.readFloatLE(index * 4)
  return request.kind === 'bpm'
    ? detectBpmFromSamples(samples, request.sampleRate)
    : detectMusicalKeyFromSamples(samples, request.sampleRate, request.stems ?? [])
}

void analyze(workerData as MediaAnalysisRequest).then(
  result => { parentPort?.postMessage({ result }); parentPort?.close() },
  error => { parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }); parentPort?.close() }
)
