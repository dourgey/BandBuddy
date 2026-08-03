import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'resources')
const downloads = path.join(resources, '.downloads')
const bin = path.join(resources, 'bin')
const stagingBin = path.join(resources, `.bin-staging-${process.pid}`)
const manifest = JSON.parse(readFileSync(path.join(resources, 'tool-manifest.json'), 'utf8'))
const targetPlatform = process.env.BANDBUDDY_TOOL_PLATFORM ?? process.platform
const targetArch = process.env.BANDBUDDY_TOOL_ARCH ?? process.arch
const targetKey = `${targetPlatform}-${targetArch}`
const target = manifest.targets[targetKey]
const useChinaMirror = process.argv.includes('--china')
const githubProxies = (process.env.BANDBUDDY_GITHUB_PROXY
  ? process.env.BANDBUDDY_GITHUB_PROXY.split(',')
  : ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/'])
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => value.replace(/\/*$/, '/'))

if (!target) throw new Error(`Unsupported desktop tool target: ${targetKey}`)

mkdirSync(downloads, { recursive: true })
rmSync(stagingBin, { recursive: true, force: true })
mkdirSync(stagingBin, { recursive: true })
process.on('exit', () => rmSync(stagingBin, { recursive: true, force: true }))

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function renameWithRetry(source, destination) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const transient = process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)
      if (!transient || attempt >= 12) throw error
      await wait(attempt * 100)
    }
  }
}

function sourceUrls(definition) {
  if (!useChinaMirror) return [definition.url]
  let githubUrl = definition.url.startsWith('https://github.com/') ? definition.url : null
  const astralUvPrefix = 'https://releases.astral.sh/github/uv/'
  if (definition.url.startsWith(astralUvPrefix)) {
    githubUrl = `https://github.com/astral-sh/uv/${definition.url.slice(astralUvPrefix.length)}`
  }
  return githubUrl ? [...githubProxies.map((proxy) => `${proxy}${githubUrl}`), definition.url] : [definition.url]
}

async function downloadSource(name, definition, temporary) {
  let lastError
  for (const url of sourceUrls(definition)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const offset = existsSync(temporary) ? statSync(temporary).size : 0
        const response = await fetch(url, {
          redirect: 'follow',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined
        })
        if (response.status === 416) {
          rmSync(temporary, { force: true })
          const error = new Error(`${name} partial download is no longer resumable`)
          error.retryable = true
          throw error
        }
        if (!response.ok || !response.body) {
          const error = new Error(`${name} download failed: HTTP ${response.status}`)
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500
          throw error
        }
        const resumed = offset > 0 && response.status === 206
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: resumed ? 'a' : 'w' }))
        const bytes = readFileSync(temporary)
        if (sha256(bytes) !== definition.sha256) {
          rmSync(temporary, { force: true })
          const error = new Error(`${name} SHA-256 mismatch from ${new URL(url).host}`)
          error.retryable = false
          throw error
        }
        return bytes
      } catch (error) {
        lastError = error
        if (error?.retryable === false || attempt === 3) break
        console.warn(`${name} download attempt ${attempt} failed; resuming...`)
        await wait(attempt * 1_000)
      }
    }
  }
  throw lastError
}

async function bytesFor(name, definition) {
  const cachedPath = path.join(downloads, definition.archive)
  if (existsSync(cachedPath)) {
    const cached = readFileSync(cachedPath)
    if (sha256(cached) === definition.sha256) return cached
    rmSync(cachedPath, { force: true })
  }
  console.log(`Downloading ${name} ${definition.version} for ${targetKey}...`)
  const temporary = `${cachedPath}.part`
  const bytes = await downloadSource(name, definition, temporary)
  renameSync(temporary, cachedPath)
  return bytes
}

function tarEntries(bytes) {
  const entries = []
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/')
    const size = Number.parseInt(text(124, 12).trim(), 8) || 0
    const type = text(156, 1)
    const dataStart = offset + 512
    if (type === '' || type === '0') entries.push({ name, data: bytes.subarray(dataStart, dataStart + size) })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

const sourceBytes = Object.fromEntries(await Promise.all(
  Object.entries(target.sources).map(async ([name, definition]) => [name, await bytesFor(name, definition)])
))

for (const file of target.files) {
  const definition = target.sources[file.source]
  const bytes = sourceBytes[file.source]
  let output
  if (definition.format === 'raw') {
    output = bytes
  } else {
    const entries = definition.format === 'zip'
      ? new AdmZip(bytes).getEntries().filter((entry) => !entry.isDirectory).map((entry) => ({ name: entry.entryName.replaceAll('\\', '/'), data: entry.getData() }))
      : definition.format === 'tar.gz'
        ? tarEntries(gunzipSync(bytes))
        : []
    const entry = entries.find((candidate) => candidate.name.endsWith(file.entrySuffix))
      ?? (file.fallbackEntry ? entries.find((candidate) => candidate.name === file.fallbackEntry) : undefined)
    if (!entry) throw new Error(`Archive entry missing for ${file.output}`)
    output = entry.data
  }
  if (sha256(output) !== file.sha256) throw new Error(`${file.output} SHA-256 mismatch`)
  const destination = path.join(stagingBin, file.output)
  writeFileSync(destination, output)
  if (file.executable && targetPlatform !== 'win32') chmodSync(destination, 0o755)
}

const previousBin = path.join(resources, `.bin-previous-${process.pid}`)
rmSync(previousBin, { recursive: true, force: true })
if (existsSync(bin)) await renameWithRetry(bin, previousBin)
try {
  await renameWithRetry(stagingBin, bin)
  rmSync(previousBin, { recursive: true, force: true })
} catch (error) {
  if (existsSync(previousBin) && !existsSync(bin)) await renameWithRetry(previousBin, bin)
  throw error
}

console.log(`Installed and verified ${target.files.length} resources for ${targetKey} in ${bin}`)
