import { execFile, spawnSync } from 'node:child_process'
import path from 'node:path'
import signingPolicy from '../../resources/macos-signing.json' with { type: 'json' }

// The release publisher, not a certificate fingerprint (certificates rotate).
const RELEASE_REQUIREMENT = `=anchor apple generic and certificate leaf[subject.OU] = "${signingPolicy.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "${signingPolicy.appId}"`

/** Asynchronous equivalent for checks on startup and interactive paths. */
export async function isTrustedMacBundleAsync(resourcesRoot: string, platform = process.platform): Promise<boolean> {
  if (platform !== 'darwin') return false
  const resources = path.resolve(resourcesRoot)
  const contents = path.dirname(resources)
  const bundle = path.dirname(contents)
  if (path.basename(resources) !== 'Resources' || path.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return false
  return await new Promise(resolve => {
    execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', RELEASE_REQUIREMENT, bundle],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 }, error => resolve(!error))
  })
}

export function isTrustedMacBundle(resourcesRoot: string, platform = process.platform): boolean {
  if (platform !== 'darwin') return false
  const resources = path.resolve(resourcesRoot)
  const contents = path.dirname(resources)
  const bundle = path.dirname(contents)
  if (path.basename(resources) !== 'Resources' || path.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return false
  // Verify the enclosing resource seal as well as nested executables. This
  // accepts release signing changes without trusting arbitrary signed tools.
  const result = spawnSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '-R', RELEASE_REQUIREMENT, bundle
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  return !result.error && result.status === 0
}
