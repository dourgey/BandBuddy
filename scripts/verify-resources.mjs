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

if (failures.length) {
  console.error(`BandBuddy resources are incomplete for ${targetKey}:\n${failures.map((item) => `- ${item}`).join('\n')}\nRun: pnpm tools:fetch`)
  process.exit(1)
}

console.log(`Verified ${target.files.length} fixed desktop resources for ${targetKey}.`)
