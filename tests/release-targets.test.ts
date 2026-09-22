import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const directory = path.resolve(import.meta.dirname, '..')
const script = pathToFileURL(path.join(directory, 'scripts/release-targets.mjs')).href
const { releaseTargets } = await import(/* @vite-ignore */ script)

describe('release target readiness', () => {
  it.each(['', 'false'])('keeps existing Windows and ARM releases available when Intel is not enabled: %s', async value => {
    const verify = vi.fn()
    const result = await releaseTargets(value, directory, verify)
    expect(result.intel).toBe(false)
    expect(result.matrix.include.map((target: { arch: string }) => target.arch)).toEqual(['arm64'])
    expect(result.message).toContain('no Intel support claim')
    expect(verify).not.toHaveBeenCalled()
  })

  it('adds Intel only after its complete runtime and CPU evidence passes', async () => {
    const verify = vi.fn().mockResolvedValue({})
    const result = await releaseTargets('true', directory, verify)
    expect(verify).toHaveBeenCalledWith(directory, false)
    expect(result.matrix.include.map((target: { arch: string }) => target.arch)).toEqual(['arm64', 'x64'])
    expect(result.matrix.include[1].runner).toBe('macos-15-intel')
    expect(result.intel).toBe(true)
  })

  it('does not silently drop Intel after an explicit opt-in fails validation', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('INTEL_RELEASE_BLOCKED: missing reference'))
    await expect(releaseTargets('true', directory, verify)).rejects.toThrow('INTEL_RELEASE_BLOCKED')
  })

  it('rejects misspelled opt-in settings', async () => {
    await expect(releaseTargets('yes', directory)).rejects.toThrow('must be true or false')
  })

  it('publishes only the selected complete matrix and excludes Intel artifacts when disabled', async () => {
    const workflow = await readFile(path.join(directory, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain("tags: ['v*']")
    expect(workflow).toContain('ENABLE_INTEL_MAC_RELEASE: ${{ vars.ENABLE_INTEL_MAC_RELEASE }}')
    expect(workflow).toContain('needs: [release-targets, windows-release, macos-release]')
    expect(workflow).toContain('if test "$INCLUDE_INTEL" = true; then')
    expect(workflow).toContain('test "${#intel[@]}" -eq 2')
    expect(workflow).toContain('test "${#intel[@]}" -eq 0')
    expect(workflow).toContain('this release includes no Intel package')
    expect(workflow.indexOf('gh release create')).toBeGreaterThan(workflow.indexOf('publish-complete-release:'))
  })

  it('uses installable Intel test versions and never attempts its packaging while disabled', async () => {
    const [workflow, intelRequirements, productionRequirements] = await Promise.all([
      readFile(path.join(directory, '.github/workflows/macos.yml'), 'utf8'),
      readFile(path.join(directory, 'python/runtime/macos-x64-test.in'), 'utf8'),
      readFile(path.join(directory, 'python/runtime/macos-x64.in'), 'utf8')
    ])
    expect(workflow).toContain('--only-binary=:all: -r python/runtime/macos-x64-test.in')
    expect(workflow.match(/if: matrix.arch == 'arm64' \|\| vars.ENABLE_INTEL_MAC_RELEASE == 'true'/g)).toHaveLength(4)
    expect(workflow).toContain('Intel native source tests ran; x64 packaging is disabled')
    const pins = intelRequirements.split('\n').filter(line => line && !line.startsWith('#'))
    for (const pin of pins) expect(productionRequirements.split('\n')).toContain(pin)
    expect(pins).toContain('torch==2.2.2')
    expect(pins).toContain('onnxruntime==1.23.2')
  })
})
