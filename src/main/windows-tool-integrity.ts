import { systemHelper } from './system-helper.js'

// Never accept merely "a valid signature". The running, installed application
// and the tool must both pass Authenticode chain validation and carry the exact
// same signing certificate. This handles packaging that re-signs bundled tools.
export async function isTrustedWindowsTool(
  toolPath: string,
  applicationPath = process.execPath,
  platform = process.platform
): Promise<boolean> {
  if (platform !== 'win32' || !/\.(exe|dll|node)$/i.test(toolPath) || !/\.exe$/i.test(applicationPath)) return false
  try {
    const result = await systemHelper(['same-publisher', applicationPath, toolPath], 15_000)
    return result.code === 0 && result.stdout.trim() === 'trusted'
  } catch { return false }
}
