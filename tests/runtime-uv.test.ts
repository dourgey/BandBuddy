import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeManager } from '../src/main/runtime.js'
import { currentToolTarget } from '../src/main/platform-tools.js'

const fixture = vi.hoisted(() => ({
  binary: Buffer.from('pinned uv test binary'),
  archive: Buffer.alloc(0),
  fetch: vi.fn(),
  trustedBundle: vi.fn(() => false)
}))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ setProxy: async () => {}, fetch: fixture.fetch }) } }))
vi.mock('../src/main/macos-bundle-integrity.js', () => ({ isTrustedMacBundle: fixture.trustedBundle }))
vi.mock('../src/main/platform-tools.js', async () => {
  const { createHash } = await import('node:crypto')
  const { default: AdmZip } = await import('adm-zip')
  const zip = new AdmZip()
  zip.addFile('uv', fixture.binary)
  fixture.archive = Buffer.from(zip.toBuffer())
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const target = {
    sources: { uv: { version: 'test', format: 'zip', url: 'https://example.invalid/uv.zip', archive: 'uv.zip', sha256: sha(fixture.archive) } },
    files: [
      { role: 'uv', source: 'uv', output: 'uv', entrySuffix: '/uv', fallbackEntry: 'uv', sha256: sha(fixture.binary) },
      { role: 'ffmpeg', output: 'ffmpeg' }
    ]
  }
  return { currentToolTarget: () => target, toolFile: (_target: unknown, role: string) => target.files.find(file => file.role === role) }
})

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let root: string
let packaged: string
let cached: string
let manager: RuntimeManager
const logger = { warn: vi.fn() }
const ensureUv = () => (manager as unknown as { ensureUv(signal: AbortSignal): Promise<string> }).ensureUv(new AbortController().signal)

beforeEach(async () => {
  vi.clearAllMocks()
  fixture.trustedBundle.mockReturnValue(false)
  fixture.fetch.mockImplementation(async () => new Response(fixture.archive))
  root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-uv-'))
  packaged = path.join(root, 'packaged', 'uv')
  cached = path.join(root, 'tools', 'uv', 'uv')
  await Promise.all(['packaged', 'tools/uv', 'downloads'].map(dir => mkdir(path.join(root, dir), { recursive: true })))
  manager = new RuntimeManager({
    packagedResource: () => packaged, toolsRoot: path.join(root, 'tools'), downloadRoot: path.join(root, 'downloads')
  } as never, { getSettings: () => ({ network: { proxyMode: 'none' } }) } as never, logger as never)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('uv integrity and distribution signing fallback', () => {
  it('uses an unchanged bundled binary without a download', async () => {
    await writeFile(packaged, fixture.binary)
    expect(await ensureUv()).toBe(packaged)
    expect(fixture.fetch).not.toHaveBeenCalled()
  })

  it('uses signed packaged uv only after verifying the complete release bundle', async () => {
    await writeFile(packaged, 'signed binary')
    fixture.trustedBundle.mockReturnValue(true)
    expect(await ensureUv()).toBe(packaged)
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.trustedBundle).toHaveBeenCalledOnce()
  })

  it('uses a verified cached binary when the packaged bytes changed', async () => {
    await writeFile(packaged, 'signed binary')
    await writeFile(cached, fixture.binary)
    expect(await ensureUv()).toBe(cached)
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    expect(await readFile(packaged, 'utf8')).toBe('signed binary')
  })

  it('downloads and verifies a standalone binary, then reuses it', async () => {
    await writeFile(packaged, 'signed binary')
    await writeFile(cached, 'corrupt cache')
    expect(await ensureUv()).toBe(cached)
    expect(await readFile(cached)).toEqual(fixture.binary)
    expect(await ensureUv()).toBe(cached)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a corrupt download even when a bundled binary exists', async () => {
    await writeFile(packaged, 'signed binary')
    fixture.fetch.mockImplementation(async () => new Response('corrupt archive'))
    await expect(ensureUv()).rejects.toThrow('UV_HASH_MISMATCH')
    expect(existsSync(cached)).toBe(false)
    expect(existsSync(path.join(root, 'downloads', 'uv.zip.part'))).toBe(false)
  })

  it('checks the extracted binary in addition to the archive', async () => {
    const zip = new AdmZip()
    zip.addFile('uv', Buffer.from('unexpected executable'))
    const archive = zip.toBuffer()
    const source = currentToolTarget().sources.uv!
    const originalDigest = source.sha256
    source.sha256 = sha(archive)
    // Reload the module because archive hashes are captured at module load.
    vi.resetModules()
    try {
      const { RuntimeManager: ReloadedManager } = await import('../src/main/runtime.js')
      Object.setPrototypeOf(manager, ReloadedManager.prototype)
      fixture.fetch.mockImplementation(async () => new Response(new Uint8Array(archive)))
      await expect(ensureUv()).rejects.toThrow('UV_HASH_MISMATCH')
      expect(existsSync(cached)).toBe(false)
    } finally {
      source.sha256 = originalDigest
    }
  })

  it('reports download failures rather than running unverified packaged uv', async () => {
    await writeFile(packaged, 'signed binary')
    fixture.fetch.mockResolvedValue({ ok: false, status: 503 })
    await expect(ensureUv()).rejects.toThrow('DOWNLOAD_HTTP_503')
    expect(existsSync(cached)).toBe(false)
  })
})
