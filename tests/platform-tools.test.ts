import { describe, expect, it } from 'vitest'
import { currentToolTarget, toolFile } from '../src/main/platform-tools.js'

describe('platform desktop tools', () => {
  it.each([
    ['win32', 'x64', 'ffmpeg.exe', 'uv.exe'],
    ['darwin', 'x64', 'ffmpeg', 'uv'],
    ['darwin', 'arm64', 'ffmpeg', 'uv']
  ] as const)('maps %s-%s to native executables', (platform, arch, ffmpeg, uv) => {
    const target = currentToolTarget(platform, arch)
    expect(toolFile(target, 'ffmpeg').output).toBe(ffmpeg)
    expect(toolFile(target, 'uv').output).toBe(uv)
    expect(toolFile(target, 'ffprobe').executable).toBe(true)
  })

  it('rejects targets without a pinned resource set', () => {
    expect(() => currentToolTarget('linux', 'x64')).toThrow('UNSUPPORTED_TOOL_TARGET:linux-x64')
  })
})
