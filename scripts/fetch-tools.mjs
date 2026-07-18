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
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function downloadArchive(name, definition) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(definition.url, { redirect: 'follow' })
      if (!response.ok) {
        const error = new Error(`${name} download failed: HTTP ${response.status}`)
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500
        throw error
      }
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (error?.retryable === false || attempt === 3) throw error
      console.warn(`${name} download attempt ${attempt} failed; retrying...`)
      await wait(attempt * 1_000)
    }
  }
  throw lastError
}

async function archiveFor(name) {
  const definition = manifest[name]
  const target = path.join(downloads, definition.archive)
  if (existsSync(target)) {
    const cached = readFileSync(target)
    if (sha256(cached) === definition.archiveSha256) return cached
    rmSync(target, { force: true })
  }
  console.log(`Downloading ${name} ${definition.version}...`)
  const bytes = await downloadArchive(name, definition)
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
