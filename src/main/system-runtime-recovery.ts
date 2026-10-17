import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { uptime } from 'node:os'
import path from 'node:path'
import type { AppPaths } from './paths.js'
import { writeJsonAtomic } from './artifact-download.js'
import { DiagnosticError } from './diagnostic-errors.js'
import { diagnostics } from './diagnostics.js'
import { processFailure, runProcess } from './process.js'
import { systemHelper } from './system-helper.js'
import { detectWindowsVcRuntime, isTrustedMicrosoftSignature, isWindowsNativeRuntimeError, parseAuthenticodeInfo } from './windows-prerequisites.js'

const markerPath = (paths: AppPaths): string => path.join(paths.localRoot, 'system-install-state.json')
const bootTime = (): number => Date.now() - uptime() * 1000
async function pendingInstall(paths: AppPaths): Promise<{ code?: number; bootTime?: number; at?: string; unknown?: boolean } | null> {
  try { return JSON.parse(await readFile(markerPath(paths), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) { diagnostics.record({ component: 'system-runtime', stage: 'read-installer-journal', result: 'unknown' }); return { unknown: true } }
    throw new DiagnosticError('STORAGE_UNAVAILABLE', '上次系统安装记录无法读取，请先检查存储位置', {}, error)
  }
}
export async function checkPendingSystemRestart(paths: AppPaths): Promise<void> {
  const pending = await pendingInstall(paths)
  if (pending && [3010, 1641].includes(pending.code ?? 0) && (!pending.bootTime || Math.abs(bootTime() - pending.bootTime) < 60_000)) {
    throw new DiagnosticError('VC_RUNTIME_RESTART_REQUIRED', '系统安装器要求重启后复检', { exitCode: pending.code, installedAt: pending.at })
  }
}
interface Options { manual?: boolean; beforeInstall?: (signal: AbortSignal) => Promise<void>; onStage?: (message: string) => void }
let active: Promise<string | null> | null = null
/** Startup recovery and normal preparation share the same system installer and journal. */
export function ensureSystemRuntime(paths: AppPaths, signal: AbortSignal, options: Options = {}): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (active) return active
  active = perform(paths, signal, options).finally(() => { active = null })
  return active
}
async function perform(paths: AppPaths, signal: AbortSignal, options: Options): Promise<string | null> {
  signal.throwIfAborted()
  await checkPendingSystemRestart(paths)
  const current = await detectWindowsVcRuntime(runProcess)
  if (current.probeError) throw new DiagnosticError('VC_RUNTIME_PROBE_FAILED', '无法确认系统运行库状态', {}, current.probeError)
  const pending = await pendingInstall(paths)
  const host = paths.audioHostExecutable()
  if (!existsSync(host)) throw new DiagnosticError('AUDIO_HOST_MISSING', '原生音频组件缺失，请修复应用安装')
  let mode = '/install'
  if (current.supported) {
    const self = await runProcess(host, ['--self-test'], { signal, timeoutMs: 30_000 })
    if (self.code === 0) { await rm(markerPath(paths), { force: true }); return current.version }
    if (!isWindowsNativeRuntimeError(String(self.code))) throw processFailure(self, 'AUDIO_HOST_SELF_TEST_FAILED')
    mode = '/repair'
  }
  if (pending && !options.manual) throw new DiagnosticError('SYSTEM_INSTALL_INTERRUPTED', '上一次系统安装尚未确认完成，需要先复检或手动修复', { pending, current })
  const installer = [paths.packagedResource('prerequisites', 'vc_redist.x64.exe'), path.join(process.cwd(), 'resources/prerequisites/vc_redist.x64.exe')].find(existsSync)
  if (!installer) throw new DiagnosticError('APPLICATION_COMPONENT_MISSING', '随软件提供的系统运行库安装器缺失')
  const signature = await systemHelper(['signature', installer])
  if (signature.code !== 0 || !isTrustedMicrosoftSignature(parseAuthenticodeInfo(signature.stdout))) throw new DiagnosticError('VC_RUNTIME_SIGNATURE_INVALID', '微软运行库安装器签名验证未通过', { result: signature })
  await options.beforeInstall?.(signal); signal.throwIfAborted()
  options.onStage?.('准备 Microsoft Visual C++ x64 运行库（请确认系统授权）')
  await writeJsonAtomic(markerPath(paths), { state: 'installing', at: new Date().toISOString(), bootTime: bootTime(), mode })
  const result = await systemHelper(['install-vc', installer, mode], 15 * 60_000)
  await writeJsonAtomic(markerPath(paths), { state: 'finished', at: new Date().toISOString(), bootTime: bootTime(), code: result.code, termination: result.termination })
  diagnostics.record({ component: 'system-runtime', stage: 'Microsoft VC installer', result: String(result.code), details: result })
  const code = result.code === 1223 ? 'VC_RUNTIME_ELEVATION_CANCELLED' : [3010, 1641].includes(result.code) ? 'VC_RUNTIME_RESTART_REQUIRED' : result.code === 1618 ? 'VC_RUNTIME_INSTALL_BUSY' : 'VC_RUNTIME_INSTALL_FAILED'
  if (result.code !== 0) throw processFailure(result, code)
  const installed = await detectWindowsVcRuntime(runProcess)
  if (installed.probeError) throw new DiagnosticError('VC_RUNTIME_PROBE_FAILED', '安装后系统运行库探测失败', {}, installed.probeError)
  if (!installed.supported) throw new DiagnosticError('VC_RUNTIME_INSTALL_FAILED', '安装器成功退出，但运行库复检未通过', { installer: result, installed })
  const self = await runProcess(host, ['--self-test'], { signal, timeoutMs: 30_000 })
  if (self.code !== 0) throw processFailure(self, 'VC_RUNTIME_SELF_TEST_FAILED')
  await rm(markerPath(paths), { force: true })
  return installed.version
}
