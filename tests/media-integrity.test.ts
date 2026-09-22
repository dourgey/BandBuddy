import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaService } from '../src/main/media.js'

const hash = vi.hoisted(() => '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7') // SHA256('data')
vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
vi.mock('../src/main/platform-tools.js', () => ({
  currentToolTarget: () => ({ ffmpegVersion: 'test', files: [
    { role: 'ffmpeg', output: 'unit-test-ffmpeg', sha256: hash },
    { role: 'ffprobe', output: 'unit-test-ffprobe', sha256: hash }
  ] }),
  toolFile: (_target: unknown, role: string) => ({ output: `unit-test-${role}` })
}))
vi.mock('../src/main/macos-bundle-integrity.js', () => ({ isTrustedMacBundleAsync: async () => false }))
vi.mock('../src/main/windows-tool-integrity.js', () => ({ isTrustedWindowsTool: async () => false }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(corrupt = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'bandbuddy-integrity-中文 '))
  roots.push(root)
  await Promise.all(['ffmpeg', 'ffprobe'].map(role => writeFile(path.join(root, `unit-test-${role}`), corrupt ? 'tampered' : 'data')))
  const paths = { packagedResource: vi.fn(() => root) }
  const logger = { error: vi.fn() }
  return { paths, logger, media: new MediaService(paths as never, {} as never, logger as never) }
}

describe('asynchronous tool verification', () => {
  it('does not inspect files in the constructor and shares concurrent verification', async () => {
    expect(createHash('sha256').update('data').digest('hex')).toBe(hash)
    const { media, paths } = await fixture()
    expect(paths.packagedResource).not.toHaveBeenCalled()
    expect(media.toolsReady()).toBe(false)
    const first = media.ready()
    expect(media.ready()).toBe(first)
    await first
    expect(media.toolsReady()).toBe(true)
    expect(media.capabilities().ffmpegReady).toBe(true)
    expect(media.tool('ffmpeg')).toContain('unit-test-ffmpeg')
  })

  it('never exposes corrupted unsigned executables as ready', async () => {
    const { media, logger } = await fixture(true)
    await media.ready()
    expect(media.toolsReady()).toBe(false)
    expect(media.tool('ffmpeg')).toBeNull()
    expect(logger.error).toHaveBeenCalledOnce()
  })
})
