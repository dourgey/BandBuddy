import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/verify-macos-target.mjs')).href
const { verifyIntelRuntimeContract, productionCodeSha256, CPU_INPUT_SHA256, CPU_MODEL_MANIFEST_SHA256 } = await import(/* @vite-ignore */ script)
const sourceRoot = path.resolve(import.meta.dirname, '..')
const policyBytes = await readFile(path.join(sourceRoot, 'python/runtime/cpu-comparison-policy.json'))
const policy = JSON.parse(policyBytes.toString())
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-intel-gate-'))
  roots.push(root)
  await Promise.all(['resources', 'python/runtime'].map(directory => mkdir(path.join(root, directory), { recursive: true })))
  await Promise.all(['worker', 'guitar_separator_hq'].map(directory => cp(path.join(sourceRoot, 'python', directory), path.join(root, 'python', directory), {
    recursive: true, filter: source => !['tests', '__pycache__'].includes(path.basename(source))
  })))
  const filename = 'sphn-0.1.12-cp312-cp312-macosx_13_0_x86_64.whl'
  const wheel = { name: 'sphn', version: '0.1.12', filename, url: `https://github.com/dourgey/BandBuddy/releases/download/runtime-wheels-sphn-0.1.12-r1/${filename}`, sha256: 'a'.repeat(64) }
  const inputs = await readFile(path.resolve(import.meta.dirname, '../python/runtime/macos-x64.in'), 'utf8')
  const releaseRoot = wheel.url.slice(0, wheel.url.lastIndexOf('/') + 1)
  const lock = [...inputs.matchAll(/^([\w.-]+)==([^\s]+)$/gm)].map(([, name, version]) => {
    const url = name === 'sphn' ? wheel.url : `${releaseRoot}${name!.toLowerCase().replace(/[-_.]+/g, '_')}-${version}-py3-none-any.whl`
    return `${name} @ ${url}#sha256=${wheel.sha256} --hash=sha256:${wheel.sha256}\n`
  }).join('')
  // Synthetic unit-test records live only in the temporary fixture, never in the release resources.
  const referenceEnvironment = { device: 'cpu', platform: 'Darwin', architecture: 'arm64', packages: policy.referencePackages }
  const pin = { schema: 1, protocol: policy.protocol, sha256: 'c'.repeat(64), policySha256: hash(policyBytes), inputSha256: CPU_INPUT_SHA256, modelManifestSha256: CPU_MODEL_MANIFEST_SHA256, productionCodeSha256: await productionCodeSha256(root), referenceEnvironment }
  const report = {
    schema: 1, protocol: policy.protocol, passed: true, policySha256: pin.policySha256, referenceSha256: pin.sha256,
    referenceManifestSha256: 'd'.repeat(64), inputSha256: pin.inputSha256, modelManifestSha256: pin.modelManifestSha256, productionCodeSha256: pin.productionCodeSha256,
    referenceEnvironment, candidateEnvironment: { device: 'cpu', platform: 'Darwin', architecture: 'x86_64', packages: { torch: '2.2.2', onnxruntime: '1.23.2' } },
    thresholds: { ...policy.thresholds }, tracks: Object.fromEntries(policy.tracks.map((name: string) => [name, { passed: true, maxAbs: 0, rmse: 0, relativeL2: 0, referencePcmSha256: 'e'.repeat(64), actualPcmSha256: 'e'.repeat(64) }]))
  }
  const evidence = { architecture: 'x86_64', platform: 'darwin', python: '3.12', deploymentTarget: '13.0', staticOpus: true, runtimeImports: true, audioRoundTrip: true, sourceSha256: '216c5f3179107080a571401694abc071cdf6059c86e8b70c8bd188e519f0ac09', wheelSha256: wheel.sha256, lockSha256: hash(lock), fullSelfTest: { ran: true, ok: true, device: 'cpu', modelInference: true, onnxCpuInference: true, guitarQualities: ['fast', 'balanced', 'high'] }, cpuComparison: { passed: true, report: 'macos-x64-cpu-comparison.json', sha256: hash(JSON.stringify(report)), referenceSha256: pin.sha256, policySha256: pin.policySha256 } }
  await Promise.all([
    writeFile(path.join(root, 'resources/runtime-wheels.json'), JSON.stringify({ schema: 1, wheels: { 'darwin-x64-cp312': wheel } })),
    writeFile(path.join(root, 'python/runtime/macos-x64.lock'), lock),
    writeFile(path.join(root, 'python/runtime/cpu-reference.json'), JSON.stringify(pin)),
    writeFile(path.join(root, 'python/runtime/macos-x64-cpu-comparison.json'), JSON.stringify(report)),
    writeFile(path.join(root, 'python/runtime/macos-x64-validation.json'), JSON.stringify(evidence))
  ])
  const writeReport = async () => {
    const bytes = JSON.stringify(report)
    evidence.cpuComparison.sha256 = hash(bytes)
    await writeFile(path.join(root, 'python/runtime/macos-x64-cpu-comparison.json'), bytes)
    await writeFile(path.join(root, 'python/runtime/macos-x64-validation.json'), JSON.stringify(evidence))
  }
  return { root, wheel, lock, evidence, pin, report, writeReport }
}

describe('Intel release gates', () => {
  it('accepts matching native evidence and immutable hashed wheel references without a network call', async () => {
    const { root, wheel } = await fixture()
    expect(await verifyIntelRuntimeContract(root, false)).toEqual(wheel)
  })

  it('blocks empty manifest rather than producing a package whose runtime cannot install', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, 'resources/runtime-wheels.json'), '{"schema":1,"wheels":{}}')
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('INTEL_RELEASE_BLOCKED')
  })

  it.each(['torch==2.2.2', 'torch @ file:///tmp/torch.whl --hash=sha256:' + 'b'.repeat(64), 'torch @ https://untrusted.example/torch.whl --hash=sha256:' + 'b'.repeat(64)])('rejects incomplete or untrusted wheelhouse entry %s', async entry => {
    const { root, lock } = await fixture()
    await writeFile(path.join(root, 'python/runtime/macos-x64.lock'), lock + entry + '\n')
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('complete runtime lock')
  })

  it('rejects evidence that skipped production inference or does not match the lock', async () => {
    const { root, evidence } = await fixture()
    for (const patch of [{ fullSelfTest: { ...evidence.fullSelfTest, guitarQualities: ['fast'] } }, { lockSha256: 'b'.repeat(64) }, { architecture: 'arm64' }]) {
      await writeFile(path.join(root, 'python/runtime/macos-x64-validation.json'), JSON.stringify({ ...evidence, ...patch }))
      await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('native Intel runtime validation')
    }
  })

  it('rejects a truncated lock even when every remaining line has a hash', async () => {
    const { root, lock } = await fixture()
    await writeFile(path.join(root, 'python/runtime/macos-x64.lock'), lock.split('\n').filter(line => !line.startsWith('torch @')).join('\n'))
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('exact production input versions')
  })

  it('rejects a macOS 14-only dependency wheel selected on a newer Intel runner', async () => {
    const { root, lock } = await fixture()
    await writeFile(path.join(root, 'python/runtime/macos-x64.lock'), lock.replace('scipy-1.17.0-py3-none-any.whl', 'scipy-1.17.0-cp312-cp312-macosx_14_0_x86_64.whl'))
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('every wheel must support')
  })

  it.each(['cpu-reference.json', 'macos-x64-cpu-comparison.json'])('blocks missing real CPU evidence: %s', async filename => {
    const { root } = await fixture()
    await rm(path.join(root, 'python/runtime', filename))
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
  })

  it('rejects outdated evidence when the current production inference code has changed', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, 'python/guitar_separator_hq/inference.py'), '# changed inference\n', { flag: 'a' })
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
  })

  it('does not invalidate inference evidence for tests alone', async () => {
    const { root, wheel } = await fixture()
    await mkdir(path.join(root, 'python/guitar_separator_hq/tests'))
    await writeFile(path.join(root, 'python/guitar_separator_hq/tests/test_new.py'), '# test-only change\n')
    expect(await verifyIntelRuntimeContract(root, false)).toEqual(wheel)
  })

  it('requires every six-stem and quality-track comparison', async () => {
    const { root, report, writeReport } = await fixture()
    delete report.tracks['high/lead_guitar']
    await writeReport()
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
  })

  it.each(['maxAbs', 'rmse', 'relativeL2'])('checks actual %s numeric error instead of trusting passed flags', async metric => {
    const { root, report, writeReport } = await fixture()
    report.tracks['balanced/acoustic_guitar'][metric] = policy.thresholds[metric] * 1.001
    await writeReport()
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
  })

  it('rejects relaxed thresholds and ARM-only candidate evidence', async () => {
    const { root, report, writeReport } = await fixture()
    report.thresholds.maxAbs = 1
    await writeReport()
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
    report.thresholds.maxAbs = policy.thresholds.maxAbs
    report.candidateEnvironment.architecture = 'arm64'
    await writeReport()
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
  })

  it('rejects a replaced report even when its numeric results pass', async () => {
    const { root, report } = await fixture()
    report.referenceManifestSha256 = 'f'.repeat(64)
    await writeFile(path.join(root, 'python/runtime/macos-x64-cpu-comparison.json'), JSON.stringify(report))
    await expect(verifyIntelRuntimeContract(root, false)).rejects.toThrow('CPU waveform comparison')
  })

  it('holds all release uploads behind the complete architecture matrix', async () => {
    const workflow = await readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('needs: [release-targets, windows-release, macos-release]')
    expect(workflow).toContain('fromJSON(needs.release-targets.outputs.matrix)')
    expect(workflow.indexOf('gh release create')).toBeGreaterThan(workflow.indexOf('publish-complete-release:'))
  })
})
