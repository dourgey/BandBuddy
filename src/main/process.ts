import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

export function spawnSafe(command: string, args: readonly string[], options: RunProcessOptions = {}): ChildProcessWithoutNullStreams {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (options.signal) {
    const abort = (): void => {
      if (!child.killed) child.kill()
    }
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
    child.once('exit', () => options.signal?.removeEventListener('abort', abort))
  }
  return child
}

export async function runProcess(command: string, args: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawnSafe(command, args, options)
    let stdout = ''
    let stderr = ''
    let stdoutPending = ''
    let stderrPending = ''

    const drainLines = (chunk: Buffer, kind: 'stdout' | 'stderr'): void => {
      const callback = kind === 'stdout' ? options.onStdoutLine : options.onStderrLine
      let pending = (kind === 'stdout' ? stdoutPending : stderrPending) + chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line) callback?.(line)
      if (kind === 'stdout') stdoutPending = pending
      else stderrPending = pending
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      drainLines(chunk, 'stdout')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      drainLines(chunk, 'stderr')
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (stdoutPending) options.onStdoutLine?.(stdoutPending)
      if (stderrPending) options.onStderrLine?.(stderrPending)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
