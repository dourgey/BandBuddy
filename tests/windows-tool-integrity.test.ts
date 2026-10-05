import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTrustedWindowsTool } from '../src/main/windows-tool-integrity.js'
const run = vi.hoisted(() => vi.fn())
vi.mock('../src/main/system-helper.js', () => ({ systemHelper: run }))
beforeEach(() => { run.mockReset() })

describe('signed Windows resource integrity', () => {
  it('checks valid app and tool chains and pins the exact signing certificate', async () => {
    run.mockResolvedValue({ code: 0, stdout: 'trusted' })
    const tool = 'C:\\中文 空格\\ffmpeg.exe'
    await expect(isTrustedWindowsTool(tool, 'C:\\Apps\\BandBuddy.exe', 'win32')).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith(['same-publisher', 'C:\\Apps\\BandBuddy.exe', tool], 15_000)
  })

  it('rejects failed verification, malformed output, and unsupported platforms', async () => {
    run.mockResolvedValue({ code: 1, stdout: 'trusted' })
    await expect(isTrustedWindowsTool('C:\\ffmpeg.exe', 'C:\\BandBuddy.exe', 'win32')).resolves.toBe(false)
    run.mockResolvedValue({ code: 0, stdout: 'Valid' })
    await expect(isTrustedWindowsTool('C:\\ffmpeg.exe', 'C:\\BandBuddy.exe', 'win32')).resolves.toBe(false)
    await expect(isTrustedWindowsTool('/tmp/tool', '/tmp/app', 'darwin')).resolves.toBe(false)
  })
})
