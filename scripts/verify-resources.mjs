import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'resources', 'tool-manifest.json'), 'utf8'))
const targetPlatform = process.env.BANDBUDDY_TOOL_PLATFORM ?? process.platform
const targetArch = process.env.BANDBUDDY_TOOL_ARCH ?? process.arch
const targetKey = `${targetPlatform}-${targetArch}`
const target = manifest.targets[targetKey]
const bin = path.join(root, 'resources', 'bin')
const failures = []

if (!target) {
  console.error(`Unsupported desktop tool target: ${targetKey}`)
  process.exit(1)
}

for (const file of target.files) {
  const targetPath = path.join(bin, file.output)
  if (!existsSync(targetPath)) {
    failures.push(`${file.output}: missing`)
    continue
  }
  const digest = createHash('sha256').update(readFileSync(targetPath)).digest('hex')
  if (digest !== file.sha256) failures.push(`${file.output}: sha256 mismatch`)
}

// Config hashes must survive Windows checkouts and packaged resource copies.
const vocal = JSON.parse(readFileSync(path.join(root, 'resources/vocal-model-catalog.json'), 'utf8'))
if (vocal.version !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(vocal.repository) || !/^vocal-v\d+\.\d+$/.test(vocal.downloadRevision) || !Array.isArray(vocal.models)
  || !vocal.models.some(model => model.id === vocal.defaultModelId)
  || new Set(vocal.models.map(model => model.id)).size !== vocal.models.length) failures.push('vocal-model-catalog: invalid header or model IDs')
for (const model of vocal.models ?? []) {
  const mirror = `https://modelscope.cn/models/${vocal.repository}/resolve/${vocal.downloadRevision}`
  if (model.urls?.length !== 1 || model.urls[0] !== `${mirror}/${model.filename}` || model.configUrl !== `${mirror}/${model.config}`) {
    failures.push(`${model.id}: vocal downloads must use the pinned ModelScope revision`)
  }
  if (!/^[\w.-]+\.yaml$/.test(model.config) || !/^[a-f0-9]{64}$/.test(model.configSha256)
    || !/^[a-f0-9]{64}$/.test(model.sha256) || !Number.isSafeInteger(model.size) || model.size <= 0) {
    failures.push(`${model.id}: invalid vocal model metadata`)
    continue
  }
  const config = path.join(root, 'python/vocal_separator/configs', model.config)
  if (!existsSync(config)) failures.push(`${model.config}: missing`)
  else if (createHash('sha256').update(readFileSync(config)).digest('hex') !== model.configSha256) failures.push(`${model.config}: sha256 mismatch`)
}

if (failures.length) {
  console.error(`BandBuddy resources are incomplete for ${targetKey}:\n${failures.map((item) => `- ${item}`).join('\n')}\nFetch missing tools with pnpm tools:fetch; restore checked-in model catalogs/configs for configuration failures.`)
  process.exit(1)
}

console.log(`Verified ${target.files.length} fixed desktop resources for ${targetKey}.`)
console.log(`Verified ${vocal.models.length} pinned optional vocal model configurations; checkpoints are downloaded on demand.`)
