import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { DiagnosticError } from './diagnostic-errors.js'
import { diagnostics } from './diagnostics.js'

const activeProcesses = new Map<ChildProcessWithoutNullStreams, () => void>()
let closing = false
type Termination = 'exited' | 'timeout' | 'cancelled' | 'interrupted' | 'signal'
const outcomes = new WeakMap<ChildProcessWithoutNullStreams, { started: number; termination?: Termination }>()

/** Await every managed child before Electron exits and removes kill timers. */
export async function shutdownProcesses(): Promise<void> {
  closing = true
  await Promise.all([...activeProcesses].map(([child, abort]) => new Promise<void>(resolve => {
    child.once('close', () => resolve())
    abort()
  })))
}

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  termination?: Termination
  signal?: NodeJS.Signals | null
  elapsedMs?: number
}

export interface RunProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  timeoutMs?: number
  maxOutputChars?: number
  killGraceMs?: number
  component?: import('@shared/environment.js').EnvironmentComponent
  stage?: string
}

export function spawnSafe(command: string, args: readonly string[], options: RunProcessOptions = {}): ChildProcessWithoutNullStreams {
  options.signal?.throwIfAborted()
  if (closing) throw new Error('APPLICATION_SHUTTING_DOWN')
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    // A private process group lets cancellation stop uv/Python descendants too.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const outcome: { started: number; termination?: Termination } = { started: Date.now() }
  outcomes.set(child, outcome)
  let escalation: NodeJS.Timeout | undefined
  let timeout: NodeJS.Timeout | undefined
  let stopping = false
  const terminate = (signal: NodeJS.Signals): void => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
  }
  const abort = (): void => {
    if (stopping) return
    stopping = true
    outcome.termination ??= closing ? 'interrupted' : options.signal?.reason?.code === 'SYSTEM_SUSPEND' ? 'interrupted' : 'cancelled'
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
      killer.once('error', () => child.kill())
      killer.once('exit', code => { if (code !== 0) child.kill() })
    } else {
      terminate('SIGTERM')
      escalation = setTimeout(() => terminate('SIGKILL'), options.killGraceMs ?? 2_000)
      escalation.unref()
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  activeProcesses.set(child, abort)
  if (options.timeoutMs && options.timeoutMs > 0) timeout = setTimeout(() => { outcome.termination = 'timeout'; abort() }, options.timeoutMs)
  const cleanup = (): void => {
    activeProcesses.delete(child)
    options.signal?.removeEventListener('abort', abort)
    if (timeout) clearTimeout(timeout)
    if (escalation) clearTimeout(escalation)
  }
  child.once('close', cleanup)
  child.once('error', cleanup)
  return child
}

export async function runProcess(command: string, args: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawnSafe(command, args, options)
    let stdout = ''
    let stderr = ''
    let stdoutPending = ''
    let stderrPending = ''
    const limit = Math.max(1024, options.maxOutputChars ?? 2 * 1024 * 1024)
    const tail = (value: string): string => value.length > limit ? value.slice(-limit) : value
    // Node's decoder retains partial UTF-8 codepoints between OS pipe chunks.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    const drainLines = (chunk: string, kind: 'stdout' | 'stderr'): void => {
      const callback = kind === 'stdout' ? options.onStdoutLine : options.onStderrLine
      let pending = (kind === 'stdout' ? stdoutPending : stderrPending) + chunk
      const lines = pending.split(/\r?\n/)
      pending = tail(lines.pop() ?? '')
      for (const line of lines) if (line) callback?.(line)
      if (kind === 'stdout') stdoutPending = pending
      else stderrPending = pending
    }

    child.stdout.on('data', (chunk: string) => {
      stdout = tail(stdout + chunk)
      drainLines(chunk, 'stdout')
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk)
      drainLines(chunk, 'stderr')
    })
    child.once('error', error => reject(new DiagnosticError('PROCESS_SPAWN_FAILED', `无法启动 ${path.basename(command)}`, { executable: path.basename(command), stage: options.stage, elapsedMs: Date.now() - outcomes.get(child)!.started }, error)))
    child.once('close', (code, signal) => {
      if (stdoutPending) options.onStdoutLine?.(stdoutPending)
      if (stderrPending) options.onStderrLine?.(stderrPending)
      const outcome = outcomes.get(child)!
      const result = { code: code ?? -1, stdout, stderr, signal, termination: outcome.termination ?? (signal ? 'signal' : 'exited'), elapsedMs: Date.now() - outcome.started }
      if (result.code !== 0 || result.termination !== 'exited') diagnostics.record({ component: options.component ?? 'task', stage: options.stage ?? path.basename(command), result: result.termination, details: { executable: path.basename(command), ...result, stdout: stdout.slice(-2000), stderr: stderr.slice(-8000) } })
      resolve(result)
    })
  })
}

export function processFailure(result: ProcessResult, code: string, details: Record<string, unknown> = {}): DiagnosticError {
  const failureCode = result.termination === 'timeout' ? 'PROCESS_TIMEOUT' : result.termination === 'cancelled' ? 'PROCESS_CANCELLED' : result.termination === 'interrupted' ? 'PROCESS_INTERRUPTED' : code
  return new DiagnosticError(failureCode, `${failureCode}:退出码=${result.code}${result.signal ? `，信号=${result.signal}` : ''}`, { ...details, exitCode: result.code, termination: result.termination, elapsedMs: result.elapsedMs, stderr: result.stderr.slice(-8000), stdout: result.stdout.slice(-2000) })
}
