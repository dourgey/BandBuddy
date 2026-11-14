import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function verifyScoreResources({ built = false, directory = root } = {}) {
  const vendor = path.join(directory, 'python/worker/muscriptor')
  const provenance = JSON.parse(readFileSync(path.join(vendor, 'PROVENANCE.json'), 'utf8'))
  if (provenance.revision !== '8a1ef88672cc23c26619adaff37ec48d82c0b906' || provenance.license !== 'MIT') throw new Error('SCORE_VENDOR_REVISION_MISMATCH')
  for (const [file, expected] of Object.entries(provenance.files)) {
    const source = readFileSync(path.join(vendor, file), 'utf8').replace(/\r\n/g, '\n')
    if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error(`SCORE_VENDOR_HASH_MISMATCH:${file}`)
  }
  const resource = path.join(directory, 'resources/score-runtime')
  const models = JSON.parse(readFileSync(path.join(resource, 'models.json'), 'utf8'))
  for (const model of ['small', 'medium', 'large']) {
    const m = models[model]
    if (!/^[a-f0-9]{40}$/.test(m.revision) || !/^[a-f0-9]{64}$/.test(m.sha256) || m.size < 400_000_000 || !m.config.card || !m.config.num_layers) throw new Error(`SCORE_MODEL_MANIFEST_INVALID:${model}`)
  }
  for (const target of ['win32-x64-cpu', 'win32-x64-cu128', 'win32-x64-cu130', 'darwin-arm64-cpu', 'darwin-x64-cpu']) {
    const lock = readFileSync(path.join(resource, `${target}.lock`), 'utf8')
    for (const dependency of ['torch', 'torchaudio', 'numpy', 'mido', 'safetensors', 'beat-this', 'psutil', 'huggingface-hub']) {
      if (!new RegExp(`^${dependency}==[^\\n]+\\\\\\r?\\n\\s+--hash=sha256:[a-f0-9]{64}`, 'm').test(lock)) throw new Error(`SCORE_LOCK_INCOMPLETE:${target}:${dependency}`)
    }
  }
  for (const file of ['LICENSES.md', 'spessasynth-LICENSE']) if (!existsSync(path.join(resource, file))) throw new Error(`SCORE_LICENSE_MISSING:${file}`)
  if (built) {
    const assets = path.join(directory, 'out/renderer/assets')
    const worklet = readdirSync(assets).some(file => /^spessasynth_processor.*\.js$/.test(file) && readFileSync(path.join(assets, file)).length > 100_000)
    if (!worklet) throw new Error('SCORE_AUDIOWORKLET_MISSING')
    const preload = readFileSync(path.join(directory, 'out/preload/index.cjs'), 'utf8')
    if (!preload.includes('scores:command') || !preload.includes('scores:changed')) throw new Error('SCORE_PRELOAD_MISSING')
  }
  return { vendorFiles: Object.keys(provenance.files).length, models: 3, runtimeLocks: 5, worklet: built }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('Verified score resources:', verifyScoreResources({ built: process.argv.includes('--built') })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
