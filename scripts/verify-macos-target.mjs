import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Anchors computed from the v1 integer input and the production model/config manifest.
export const CPU_INPUT_SHA256 = '93dfefe3a63fdf0bda67ef8054463cfd6b71e29eb50a1c234b010f94eb1944e9'
export const CPU_MODEL_MANIFEST_SHA256 = 'cf7ccc0ca97c332a3eb82f92e47b8a1ddb30995ff344e88fd0044e83bd2ca4d9'

export function wheelSupportsMacos13(filename) {
  const platforms = filename.replace(/\.whl$/, '').split('-').at(-1).split('.')
  return platforms.length === 1 && platforms[0] === 'any' || platforms.some(platform => {
    const tag = /^macosx_(\d+)_(\d+)_(x86_64|intel|fat32|fat64|universal|universal2)$/.exec(platform)
    return tag && (Number(tag[1]) < 13 || Number(tag[1]) === 13 && Number(tag[2]) === 0)
  })
}

// Keep the file set and canonical JSON identical to worker/cpu_reference.py.
export async function productionCodeSha256(directory = root) {
  const files = ['python/worker/worker.py', 'python/worker/model_download.py']
  const collect = async relative => {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'tests') await collect(`${relative}/${entry.name}`)
      else if (entry.isFile() && entry.name.endsWith('.py')) files.push(`${relative}/${entry.name}`)
    }
  }
  await collect('python/guitar_separator_hq')
  const entries = {}
  for (const relative of files.sort()) entries[relative] = createHash('sha256').update(await readFile(path.join(directory, relative))).digest('hex')
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export async function verifyCpuComparison(directory, evidence) {
  const blocked = () => { throw new Error('INTEL_RELEASE_BLOCKED: CPU waveform comparison must match the reviewed reference, fixed policy, all 15 tracks and exact numeric thresholds.') }
  const hash = value => createHash('sha256').update(value).digest('hex')
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  let pin, report, bytes, productionSha
  try {
    pin = JSON.parse(await readFile(path.join(directory, 'python/runtime/cpu-reference.json'), 'utf8'))
    bytes = await readFile(path.join(directory, 'python/runtime/macos-x64-cpu-comparison.json'))
    report = JSON.parse(bytes)
    productionSha = await productionCodeSha256(directory)
  } catch { blocked() }
  const policyBytes = await readFile(path.join(root, 'python/runtime/cpu-comparison-policy.json'))
  const policy = JSON.parse(policyBytes)
  const policySha = hash(policyBytes)
  const comparison = evidence.cpuComparison
  if (!pin || pin.schema !== 1 || pin.protocol !== policy.protocol || pin.policySha256 !== policySha || !digest(pin.sha256)
    || pin.inputSha256 !== CPU_INPUT_SHA256 || pin.modelManifestSha256 !== CPU_MODEL_MANIFEST_SHA256 || pin.productionCodeSha256 !== productionSha
    || pin.referenceEnvironment?.device !== 'cpu'
    || Object.entries(policy.referencePackages).some(([name, version]) => pin.referenceEnvironment.packages?.[name] !== version)
    || !comparison || comparison.passed !== true || comparison.report !== 'macos-x64-cpu-comparison.json'
    || comparison.sha256 !== hash(bytes) || comparison.referenceSha256 !== pin.sha256 || comparison.policySha256 !== policySha
    || report.schema !== 1 || report.protocol !== policy.protocol || report.passed !== true || report.policySha256 !== policySha
    || report.referenceSha256 !== pin.sha256 || !digest(report.referenceManifestSha256)
    || report.inputSha256 !== pin.inputSha256 || report.modelManifestSha256 !== pin.modelManifestSha256
    || report.productionCodeSha256 !== pin.productionCodeSha256
    || report.referenceEnvironment?.device !== 'cpu'
    || Object.entries(policy.referencePackages).some(([name, version]) => report.referenceEnvironment.packages?.[name] !== version)
    || report.candidateEnvironment?.device !== 'cpu' || report.candidateEnvironment?.platform !== 'Darwin'
    || report.candidateEnvironment?.architecture !== 'x86_64'
    || report.candidateEnvironment?.packages?.torch !== '2.2.2' || report.candidateEnvironment?.packages?.onnxruntime !== '1.23.2'
    || JSON.stringify(Object.keys(report.tracks ?? {}).sort()) !== JSON.stringify([...policy.tracks].sort())
    || Object.keys(report.thresholds ?? {}).length !== Object.keys(policy.thresholds).length
    || Object.entries(policy.thresholds).some(([key, value]) => report.thresholds[key] !== value)) blocked()
  for (const name of policy.tracks) {
    const track = report.tracks[name]
    if (track.passed !== true || !digest(track.referencePcmSha256) || !digest(track.actualPcmSha256)
      || Object.entries(policy.thresholds).some(([key, limit]) => !Number.isFinite(track[key]) || track[key] < 0 || track[key] > limit)) blocked()
  }
}

export async function verifyIntelRuntimeContract(directory = root, checkPublishedWheel = true) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'resources/runtime-wheels.json'), 'utf8'))
  const wheel = manifest.schema === 1 && manifest.wheels?.['darwin-x64-cp312']
  const filename = 'sphn-0.1.12-cp312-cp312-macosx_13_0_x86_64.whl'
  if (!wheel || wheel.name !== 'sphn' || wheel.version !== '0.1.12' || wheel.filename !== filename
    || !/^[a-f0-9]{64}$/.test(wheel.sha256 ?? '')
    || !/^https:\/\/github\.com\/dourgey\/BandBuddy\/releases\/download\/(?!latest(?:\/|$))[^/]+\/sphn-0\.1\.12-cp312-cp312-macosx_13_0_x86_64\.whl$/.test(wheel.url ?? '')) {
    throw new Error('INTEL_RELEASE_BLOCKED: run the native Intel runtime-wheel workflow, publish its reviewed immutable wheel and commit the real manifest/hash lock/validation evidence before packaging.')
  }
  const lock = await readFile(path.join(directory, 'python/runtime/macos-x64.lock'), 'utf8')
  const requirements = lock.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const releaseRoot = wheel.url.slice(0, wheel.url.lastIndexOf('/') + 1)
  const artifacts = requirements.map(line => {
    const match = /^([\w.-]+)\s+@\s+(https:\/\/\S+\.whl)(?:#sha256=([a-f0-9]{64}))?\s+--hash=sha256:([a-f0-9]{64})$/.exec(line)
    return match && (!match[3] || match[3] === match[4]) && match[2].startsWith(releaseRoot)
      && !match[2].slice(releaseRoot.length).includes('/') ? { name: match[1].toLowerCase().replace(/[-_.]+/g, '-'), url: match[2], sha256: match[4] } : null
  })
  if (!requirements.length || artifacts.some(item => !item)
    || !lock.includes(wheel.url) || !lock.includes(wheel.sha256) || /file:\/\/|\s@\s*\//.test(lock)) {
    throw new Error('INTEL_RELEASE_BLOCKED: the complete runtime lock must pin every dependency with hashes and reference the published sphn wheel.')
  }
  if (artifacts.some(artifact => !wheelSupportsMacos13(artifact.url.split('/').pop()))) {
    throw new Error('INTEL_RELEASE_BLOCKED: every wheel must support CPython 3.12 on macOS 13 Intel; a newer runner is not a minimum-OS test.')
  }
  const inputs = await readFile(path.join(root, 'python/runtime/macos-x64.in'), 'utf8')
  const required = [...inputs.matchAll(/^([\w.-]+)==([^\s]+)$/gm)]
  const locked = new Map(artifacts.map(artifact => [artifact.name, artifact]))
  if (locked.size !== artifacts.length || required.some(([, name, version]) => {
    const filename = locked.get(name.toLowerCase().replace(/[-_.]+/g, '-'))?.url.split('/').pop()?.toLowerCase()
    return !filename?.startsWith(`${name.toLowerCase().replace(/[-_.]+/g, '_')}-${version}-`)
  })) throw new Error('INTEL_RELEASE_BLOCKED: the complete runtime lock must include the exact production input versions without duplicates.')
  const evidence = JSON.parse(await readFile(path.join(directory, 'python/runtime/macos-x64-validation.json'), 'utf8'))
  const lockSha256 = createHash('sha256').update(lock).digest('hex')
  const test = evidence.fullSelfTest
  if (!test || test.device !== 'cpu' || !['ran', 'ok', 'modelInference', 'onnxCpuInference'].every(key => test[key] === true)
    || JSON.stringify(test.guitarQualities) !== JSON.stringify(['fast', 'balanced', 'high'])
    || evidence.architecture !== 'x86_64' || evidence.platform !== 'darwin' || evidence.python !== '3.12'
    || evidence.sourceSha256 !== '216c5f3179107080a571401694abc071cdf6059c86e8b70c8bd188e519f0ac09'
    || evidence.wheelSha256 !== wheel.sha256 || evidence.lockSha256 !== lockSha256
    || evidence.staticOpus !== true || evidence.runtimeImports !== true || evidence.audioRoundTrip !== true || evidence.deploymentTarget !== '13.0') {
    throw new Error('INTEL_RELEASE_BLOCKED: native Intel runtime validation must match this exact wheel and complete lock.')
  }
  await verifyCpuComparison(directory, evidence)
  if (checkPublishedWheel) {
    for (const artifact of artifacts) {
      const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok || !response.body) throw new Error(`INTEL_RELEASE_BLOCKED: published wheel unavailable (${response.status}): ${artifact.url}`)
      const hash = createHash('sha256')
      for await (const chunk of response.body) hash.update(chunk)
      if (hash.digest('hex') !== artifact.sha256) throw new Error(`INTEL_RELEASE_BLOCKED: published wheel hash mismatch: ${artifact.url}`)
    }
  }
  return wheel
}

async function main() {
  const arch = process.argv[2]
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Specify the native macOS target: x64 or arm64')
  if (process.platform !== 'darwin' || process.arch !== arch) throw new Error(`MAC_NATIVE_TARGET_REQUIRED:${arch}; build and validate on a native ${arch} macOS runner`)
  const translated = await promisify(execFile)('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 5000 }).catch(() => ({ stdout: '0' }))
  if (translated.stdout.trim() === '1') throw new Error('MAC_NATIVE_TARGET_REQUIRED: Rosetta does not count as native validation')
  if (arch === 'x64') await verifyIntelRuntimeContract()
  console.log(`Verified native macOS packaging target: ${arch}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
