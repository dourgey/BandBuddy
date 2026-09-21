import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTrustedMacBundle } from '../src/main/macos-bundle-integrity.js'
const run = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync: run }))
beforeEach(() => run.mockReset())
describe('signed macOS resource integrity', () => {
  it('requires a strict resource seal, nested signatures and the release publisher', () => {
    run.mockReturnValue({ status: 0 })
    expect(isTrustedMacBundle('/Applications/BandBuddy.app/Contents/Resources', 'darwin')).toBe(true)
    expect(run).toHaveBeenCalledWith('/usr/bin/codesign', [
      '--verify', '--deep', '--strict', '-R',
      '=anchor apple generic and certificate leaf[subject.OU] = "M6M993UYR9" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "com.bandbuddy.desktop"',
      path.resolve('/Applications/BandBuddy.app')
    ], expect.objectContaining({ timeout: 15_000 }))
  })
  it.each([{ status: 1 }, { status: null }, { status: 0, error: new Error('timeout') }])('rejects invalid, interrupted or timed-out verification: %j', result => {
    run.mockReturnValue(result)
    expect(isTrustedMacBundle('/Applications/BandBuddy.app/Contents/Resources', 'darwin')).toBe(false)
  })
  it('does not extend trust to development directories or other platforms', () => {
    expect(isTrustedMacBundle('/tmp/resources', 'darwin')).toBe(false)
    expect(isTrustedMacBundle('/Applications/BandBuddy.app/Contents/Resources', 'win32')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
