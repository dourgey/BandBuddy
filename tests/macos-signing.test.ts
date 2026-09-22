import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { selectIdentity, scanCode, assertRequiredCode, deploymentTargets, policy } = require('../scripts/macos-signing.cjs')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hashA = 'A'.repeat(40)
const hashB = 'B'.repeat(40)
const certificate = `Developer ID Application: Jie Zhao (${policy.teamId})`

describe('macOS release signing', () => {
  it('reads both deployment load-command forms without confusing linked library versions', () => {
    expect(deploymentTargets(`Load command 1\n cmd LC_BUILD_VERSION\n minos 13.0\n sdk 15.0\nLoad command 2\n cmd LC_LOAD_DYLIB\n current version 120.0.0\nLoad command 3\n cmd LC_VERSION_MIN_MACOSX\n version 12.0\n sdk 15.0`)).toEqual(['13.0', '12.0'])
  })
  it('selects a fingerprint deterministically when names are duplicated', () => {
    const output = `1) ${hashB} "${certificate}"\n2) ${hashA} "${certificate}"`
    expect(selectIdentity(output).hash).toBe(hashA)
    expect(selectIdentity(output, hashB.toLowerCase()).hash).toBe(hashB)
  })

  it('rejects missing certificates, different teams, development and unknown identities', () => {
    for (const output of ['', `1) ${hashA} "Apple Development: Person (${policy.teamId})"`, `1) ${hashA} "Developer ID Application: Other (OTHERTEAM)"`]) {
      expect(() => selectIdentity(output)).toThrow('MAC_SIGNING_IDENTITY_MISSING')
    }
    expect(() => selectIdentity(`1) ${hashA} "${certificate}"`, hashB)).toThrow('MAC_SIGNING_IDENTITY_MISSING')
  })

  it('discovers extensionless tools, dylibs, native modules and bundles without signing resources or revisiting symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-signing-'))
    roots.push(root)
    const app = path.join(root, 'BandBuddy.app')
    const framework = path.join(app, 'Contents/Frameworks/Example.framework')
    const version = path.join(framework, 'Versions/A')
    await mkdir(version, { recursive: true })
    await mkdir(path.join(app, 'Contents/Resources'), { recursive: true })
    const files = [path.join(version, 'Example'), path.join(version, 'test.dylib'), path.join(app, 'Contents/Resources/native.node')]
    for (const file of files) await writeFile(file, Buffer.from('cffaedfe00000000', 'hex'))
    await writeFile(path.join(version, 'locale.pak'), 'plain data')
    await writeFile(path.join(app, 'Contents/Resources/worker.py'), 'print("worker")')
    await symlink(version, path.join(framework, 'Versions/Current'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await scanCode(app)
    expect(result.binaries).toEqual(files.sort())
    expect(result.bundles).toEqual([framework, app])
  })

  it('fails if a required packaged helper is absent', () => {
    expect(() => assertRequiredCode('/tmp/BandBuddy.app', { binaries: [] })).toThrow('MAC_REQUIRED_BINARY_MISSING')
  })

  it('makes signed packaging the default and leaves unsigned CI explicitly separate', async () => {
    const root = path.resolve(import.meta.dirname, '..')
    const config = await readFile(path.join(root, 'electron-builder.macos.yml'), 'utf8')
    const unsigned = await readFile(path.join(root, 'electron-builder.macos-unsigned.yml'), 'utf8')
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(config).toContain('forceCodeSigning: true')
    expect(config).toContain('hardenedRuntime: true')
    expect(config).toContain('sign: scripts/sign-macos.cjs')
    expect(config).toContain('afterAllArtifactBuild: scripts/verify-macos-release.cjs')
    expect(unsigned).toContain('identity: null')
    expect(pkg.scripts['package:mac']).toContain('--config electron-builder.macos.yml')
    expect(pkg.scripts['package:mac:unsigned']).toContain('--config electron-builder.macos-unsigned.yml')
    expect(pkg.scripts['package:mac:x64']).toContain('verify-macos-target.mjs x64')
    expect(pkg.scripts['package:mac:x64']).toContain('--x64')
    expect(pkg.scripts['package:mac:x64:unsigned']).toContain('--config electron-builder.macos-unsigned.yml')
  })
})
