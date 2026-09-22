import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyIntelRuntimeContract } from './verify-macos-target.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arm = { arch: 'arm64', native: 'arm64', runner: 'macos-15', package_script: 'package:mac' }
const intel = { arch: 'x64', native: 'x86_64', runner: 'macos-15-intel', package_script: 'package:mac:x64' }

export async function releaseTargets(requested = '', directory = root, verify = verifyIntelRuntimeContract) {
  if (!['', 'false', 'true'].includes(requested)) throw new Error('ENABLE_INTEL_MAC_RELEASE must be true or false')
  const includeIntel = requested === 'true'
  // Explicitly enabled Intel releases fail closed. They never silently fall back to ARM-only.
  if (includeIntel) await verify(directory, false)
  return {
    intel: includeIntel,
    matrix: { include: includeIntel ? [arm, intel] : [arm] },
    message: includeIntel
      ? 'Intel release explicitly enabled: Windows, Apple Silicon and Intel must all pass before publication.'
      : 'Intel release disabled pending native runtime and CPU reference validation. Publishing Windows and Apple Silicon only; no Intel support claim.'
  }
}

async function main() {
  const result = await releaseTargets(process.env.ENABLE_INTEL_MAC_RELEASE ?? '')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `intel=${result.intel}\nmatrix=${JSON.stringify(result.matrix)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result.message}\n`)
  console.log(result.message)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
