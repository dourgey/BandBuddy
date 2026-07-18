import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'resources')
const downloads = path.join(resources, '.downloads')
const bin = path.join(resources, 'bin')
const manifest = JSON.parse(readFileSync(path.join(resources, 'tool-manifest.json'), 'utf8'))
mkdirSync(downloads, { recursive: true })
mkdirSync(bin, { recursive: true })

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function archiveFor(name) {
  const definition = manifest[name]
  const target = path.join(downloads, definition.archive)
  if (existsSync(target)) {
    const cached = readFileSync(target)
    if (sha256(cached) === definition.archiveSha256) return cached
    rmSync(target, { force: true })
  }
  console.log(`Downloading ${name} ${definition.version}...`)
  const response = await fetch(definition.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256(bytes) !== definition.archiveSha256) throw new Error(`${name} archive SHA-256 mismatch; upstream asset changed`)
  const temporary = `${target}.part`
  writeFileSync(temporary, bytes)
  renameSync(temporary, target)
  return bytes
}

const archives = {
  uv: new AdmZip(await archiveFor('uv')),
  ffmpeg: new AdmZip(await archiveFor('ffmpeg'))
}

for (const file of manifest.files) {
  const entries = archives[file.archive].getEntries()
  const entry = entries.find((candidate) => candidate.entryName.replaceAll('\\', '/').endsWith(file.entrySuffix))
    ?? (file.fallbackEntry ? entries.find((candidate) => candidate.entryName === file.fallbackEntry) : undefined)
  if (!entry || entry.isDirectory) throw new Error(`Archive entry missing for ${file.output}`)
  const bytes = entry.getData()
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.output} SHA-256 mismatch`)
  writeFileSync(path.join(bin, file.output), bytes)
}

console.log(`Installed and verified ${manifest.files.length} resources in ${bin}`)
