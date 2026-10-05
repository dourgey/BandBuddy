import { existsSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from './process.js'

export function systemHelperPath(): string {
  const relative = ['system-helper', 'win32-x64', 'bandbuddy-system-helper.exe']
  const packaged = path.join(process.resourcesPath ?? '', ...relative)
  return existsSync(packaged) ? packaged : path.join(process.cwd(), 'resources', ...relative)
}
export async function systemHelper(args: string[], timeoutMs = 30_000): Promise<Awaited<ReturnType<typeof runProcess>>> {
  const executable = systemHelperPath()
  if (!existsSync(executable)) throw new Error('SYSTEM_HELPER_MISSING')
  return runProcess(executable, args, { timeoutMs })
}
