import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'resources', 'tool-manifest.json'), 'utf8'))
const bin = path.join(root, 'resources', 'bin')
const failures = []

for (const file of manifest.files) {
  const target = path.join(bin, file.output)
  if (!existsSync(target)) {
    failures.push(`${file.output}: missing`)
    continue
  }
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex')
  if (digest !== file.sha256) failures.push(`${file.output}: sha256 mismatch`)
}

if (failures.length) {
  console.error(`BandBuddy resources are incomplete:\n${failures.map((item) => `- ${item}`).join('\n')}\nRun: pnpm tools:fetch`)
  process.exit(1)
}

console.log(`Verified ${manifest.files.length} fixed desktop resources.`)
