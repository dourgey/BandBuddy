import { execFile } from 'node:child_process'
import path from 'node:path'

// Never accept merely "a valid signature". The running, installed application
// and the tool must both pass Authenticode chain validation and carry the exact
// same signing certificate. This handles packaging that re-signs bundled tools.
const VERIFY_SAME_PUBLISHER = `
$ErrorActionPreference = 'Stop'
try {
  $app = Get-AuthenticodeSignature -LiteralPath $env:BANDBUDDY_VERIFY_APPLICATION
  $tool = Get-AuthenticodeSignature -LiteralPath $env:BANDBUDDY_VERIFY_TOOL
  if ($app.Status -ne 'Valid' -or $tool.Status -ne 'Valid' -or !$app.SignerCertificate -or !$tool.SignerCertificate) { exit 1 }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $appPin = [Convert]::ToBase64String($sha.ComputeHash($app.SignerCertificate.GetRawCertData()))
    $toolPin = [Convert]::ToBase64String($sha.ComputeHash($tool.SignerCertificate.GetRawCertData()))
    if ($appPin -cne $toolPin) { exit 1 }
    [Console]::Out.Write('trusted')
  } finally { $sha.Dispose() }
} catch { exit 1 }
`

export async function isTrustedWindowsTool(
  toolPath: string,
  applicationPath = process.execPath,
  platform = process.platform
): Promise<boolean> {
  if (platform !== 'win32' || !/\.(exe|dll|node)$/i.test(toolPath) || !/\.exe$/i.test(applicationPath)) return false
  const powershell = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return await new Promise(resolve => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERIFY_SAME_PUBLISHER], {
      windowsHide: true, timeout: 15_000, maxBuffer: 4096, encoding: 'utf8',
      env: { ...process.env, BANDBUDDY_VERIFY_APPLICATION: applicationPath, BANDBUDDY_VERIFY_TOOL: toolPath }
    }, (error, stdout) => resolve(!error && stdout.trim() === 'trusted'))
  })
}
