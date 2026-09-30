import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaService } from '../src/main/media.js'

const reads = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('electron', () => ({ app: {}, protocol: {} }))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  createReadStream: reads.stream
}))
vi.mock('../src/main/macos-bundle-integrity.js', () => ({ isTrustedMacBundle: () => false }))
vi.mock('../src/main/platform-tools.js', async () => {
  const { createHash } = await import('node:crypto')
  const files = ['ffmpeg', 'ffprobe'].map(role => ({ role, output: `${role}.exe`, sha256: createHash('sha256').update(role).digest('hex') }))
  return { currentToolTarget: () => ({ files, ffmpegVersion: 'test' }), toolFile: (_target: unknown, role: string) => files.find(file => file.role === role) }
})

function service() {
  const changed = vi.fn()
  const error = vi.fn()
  const media = new MediaService({ packagedResource: () => '/tools' } as never, {} as never, { error } as never, changed)
  return { media, changed, error }
}

describe('on-demand media integrity verification', () => {
  beforeEach(() => {
    reads.stream.mockReset().mockImplementation((file: string) => Readable.from([file.includes('ffprobe') ? 'ffprobe' : 'ffmpeg']))
  })

  it('does no binary reads during construction or capability queries', () => {
    const { media } = service()
    expect(media.capabilities()).toMatchObject({ ffmpegReady: false, ffmpegVerification: 'unchecked' })
    expect(reads.stream).not.toHaveBeenCalled()
  })

  it('shares one verification for concurrent operations and caches verified tools', async () => {
    const { media, changed } = service()
    const results = await Promise.all([media.tool('ffmpeg'), media.tool('ffprobe'), media.toolsReady()])
    expect(results[0]).toMatch(/ffmpeg\.exe$/)
    expect(results[1]).toMatch(/ffprobe\.exe$/)
    expect(results[2]).toBe(true)
    expect(reads.stream).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls.map(([value]) => value.ffmpegVerification)).toEqual(['checking', 'verified'])
    await media.tool('ffmpeg')
    expect(reads.stream).toHaveBeenCalledTimes(2)
  })

  it('never exposes a corrupt executable and caches the failed check', async () => {
    reads.stream.mockImplementation(() => Readable.from(['corrupt']))
    const { media, error } = service()
    expect(await media.tool('ffmpeg')).toBeNull()
    const count = reads.stream.mock.calls.length
    expect(await media.toolsReady()).toBe(false)
    expect(reads.stream).toHaveBeenCalledTimes(count)
    expect(media.capabilities().ffmpegVerification).toBe('failed')
    expect(error).toHaveBeenCalledOnce()
  })

  it('handles unreadable binaries without rejecting concurrent callers', async () => {
    reads.stream.mockImplementation(() => { throw new Error('EACCES') })
    const { media } = service()
    expect(await Promise.all([media.tool('ffmpeg'), media.tool('ffprobe')])).toEqual([null, null])
    expect(media.capabilities().ffmpegReady).toBe(false)
  })
})
