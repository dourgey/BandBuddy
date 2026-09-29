import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'MODO-DRUM-STUDIO-One-Shots'))
const target = path.join(root, 'src', 'renderer', 'public', 'woodshed', 'drums')
const ffmpeg = path.join(root, 'resources', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const sourceManifest = JSON.parse(readFileSync(path.join(source, 'index.json'), 'utf8'))
if (sourceManifest.sampleCount !== 34 || sourceManifest.samples.length !== 34) throw new Error('Expected 34 drum samples')

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `ffmpeg exited ${result.status}`)
  return result.stdout
}

function pcmHash(file) {
  const output = run(['-i', file, '-map', '0:a:0', '-c:a', 'pcm_s24le', '-f', 'streamhash', '-hash', 'SHA256', '-'])
  const result = output.match(/SHA256=([a-f0-9]{64})/i)?.[1]?.toLowerCase()
  if (!result) throw new Error(`Missing PCM hash: ${file}`)
  return result
}

let sourceBytes = 0
let compressedBytes = 0
const samples = sourceManifest.samples.map((sample) => {
  const input = path.join(source, sample.file)
  if (hash(input) !== sample.sha256) throw new Error(`Source SHA-256 mismatch: ${sample.file}`)
  const relative = sample.file.replace(/\.wav$/i, '.flac')
  const output = path.join(target, relative)
  mkdirSync(path.dirname(output), { recursive: true })
  run(['-y', '-i', input, '-map', '0:a:0', '-c:a', 'flac', '-compression_level', '12', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', output])
  const originalPcm = pcmHash(input)
  const compressedPcm = pcmHash(output)
  if (originalPcm !== compressedPcm) throw new Error(`PCM changed: ${sample.file}`)
  sourceBytes += statSync(input).size
  compressedBytes += statSync(output).size
  return {
    ...sample,
    file: relative,
    sourceFile: sample.file,
    sourceSha256: sample.sha256,
    sha256: hash(output),
    pcmSha256: originalPcm
  }
})
writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify({ ...sourceManifest, compression: 'FLAC level 12, lossless 24-bit PCM', sourceBytes, compressedBytes, samples }, null, 2)}\n`)
console.log(`Verified ${samples.length} lossless drum samples: ${sourceBytes} -> ${compressedBytes} bytes (${(100 * compressedBytes / sourceBytes).toFixed(1)}%)`)
