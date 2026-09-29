import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'public', 'woodshed', 'drums')
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
if (manifest.sampleCount !== 34 || manifest.samples.length !== 34) throw new Error('Drum sample count mismatch')
const notes = new Set()
let bytes = 0
for (const sample of manifest.samples) {
  if (notes.has(sample.midiNote) || !/^[a-z0-9-]+\/[a-z0-9_.-]+\.flac$/i.test(sample.file)) throw new Error(`Invalid drum sample entry: ${sample.file}`)
  notes.add(sample.midiNote)
  const file = path.join(root, sample.file)
  const data = readFileSync(file)
  if (data.toString('ascii', 0, 4) !== 'fLaC') throw new Error(`Invalid FLAC: ${sample.file}`)
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== sample.sha256) throw new Error(`Drum sample SHA-256 mismatch: ${sample.file}`)
  bytes += statSync(file).size
}
const actualFiles = readdirSync(root, { recursive: true }).filter((name) => name.endsWith('.flac'))
if (actualFiles.length !== 34 || bytes !== manifest.compressedBytes) throw new Error('Drum asset inventory mismatch')
console.log(`Verified ${notes.size} FLAC drum samples, ${bytes} bytes.`)
