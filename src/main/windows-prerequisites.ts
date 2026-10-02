import type { ProcessResult } from './process.js'

export const VC_RUNTIME_MIN_VERSION = '14.44.0.0'
export const VC_RUNTIME_DOWNLOAD_URL = 'https://aka.ms/vc14/vc_redist.x64.exe'
export const VC_RUNTIME_REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'

export interface WindowsVcRuntimeInfo {
  installed: boolean
  version: string | null
  supported: boolean
}

export interface AuthenticodeInfo {
  status: string
  subject: string
}

type ProcessRunner = (command: string, args: readonly string[], options?: { timeoutMs: number }) => Promise<ProcessResult>

function versionParts(value: string): number[] | null {
  const normalized = value.trim().replace(/^v/i, '')
  if (!/^\d+(?:\.\d+){1,3}$/.test(normalized)) return null
  const parts = normalized.split('.').map(Number)
  while (parts.length < 4) parts.push(0)
  return parts
}

export function compareRuntimeVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  if (!leftParts || !rightParts) return Number.NaN
  for (let index = 0; index < 4; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

export function parseVcRuntimeRegistry(output: string, minimum = VC_RUNTIME_MIN_VERSION): WindowsVcRuntimeInfo {
  const installedValue = /^\s*Installed\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(output)?.[1]
  const version = /^\s*Version\s+REG_SZ\s+(v?\d+(?:\.\d+){1,3})\s*$/im.exec(output)?.[1] ?? null
  const installed = installedValue !== undefined && Number.parseInt(installedValue, 16) === 1
  const comparison = version ? compareRuntimeVersions(version, minimum) : Number.NaN
  return { installed, version, supported: installed && Number.isFinite(comparison) && comparison >= 0 }
}

export async function detectWindowsVcRuntime(run: ProcessRunner): Promise<WindowsVcRuntimeInfo> {
  try {
    const result = await run('reg.exe', ['query', VC_RUNTIME_REGISTRY_KEY, '/reg:64'], { timeoutMs: 8_000 })
    if (result.code !== 0) return { installed: false, version: null, supported: false }
    return parseVcRuntimeRegistry(result.stdout)
  } catch {
    return { installed: false, version: null, supported: false }
  }
}

export function parseAuthenticodeInfo(output: string): AuthenticodeInfo | null {
  try {
    const value = JSON.parse(output) as Partial<AuthenticodeInfo>
    if (typeof value.status !== 'string' || typeof value.subject !== 'string') return null
    return { status: value.status, subject: value.subject }
  } catch {
    return null
  }
}

export function isTrustedMicrosoftSignature(info: AuthenticodeInfo | null): boolean {
  return info?.status.toLowerCase() === 'valid'
    && /(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)/i.test(info.subject)
}

export function isWindowsNativeRuntimeError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return /WinError\s*(?:1114|126)|c10\.dll|MSVCP140(?:_\d+)?\.dll|VCRUNTIME140(?:_\d+)?\.dll|DLL initialization routine failed|动态链接库\s*\(DLL\)\s*初始化例程失败/i.test(text)
}
