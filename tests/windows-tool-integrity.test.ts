import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTrustedWindowsTool } from '../src/main/windows-tool-integrity.js'
const run = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: run }))
beforeEach(() => { run.mockReset() })

describe('signed Windows resource integrity', () => {
  it('checks valid app and tool chains and pins the exact signing certificate', async () => {
    run.mockImplementation((_file, _args, _options, callback) => callback(null, 'trusted'))
    const tool = 'C:\\中文 空格\\ffmpeg.exe'
    await expect(isTrustedWindowsTool(tool, 'C:\\Apps\\BandBuddy.exe', 'win32')).resolves.toBe(true)
    const [, args, options] = run.mock.calls[0]!
    expect(args.at(-1)).toContain("$app.Status -ne 'Valid' -or $tool.Status -ne 'Valid'")
    expect(args.at(-1)).toContain('$appPin -cne $toolPin')
    expect(args.at(-1)).toContain('SHA256')
    expect(args.at(-1)).not.toContain(tool)
    expect(options.env.BANDBUDDY_VERIFY_TOOL).toBe(tool)
  })

  it('rejects failed verification, malformed output, and unsupported platforms', async () => {
    run.mockImplementation((_file, _args, _options, callback) => callback(new Error('untrusted'), 'trusted'))
    await expect(isTrustedWindowsTool('C:\\ffmpeg.exe', 'C:\\BandBuddy.exe', 'win32')).resolves.toBe(false)
    run.mockImplementation((_file, _args, _options, callback) => callback(null, 'Valid'))
    await expect(isTrustedWindowsTool('C:\\ffmpeg.exe', 'C:\\BandBuddy.exe', 'win32')).resolves.toBe(false)
    await expect(isTrustedWindowsTool('/tmp/tool', '/tmp/app', 'darwin')).resolves.toBe(false)
  })
})
