import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export function activeEnvironment(root: string): string {
  try {
    const value = JSON.parse(readFileSync(path.join(root, 'active-environment.json'), 'utf8')) as { directory?: unknown; previousRuntimeRoot?: unknown }
    // Only an explicit data migration writes this non-recursive reference. We
    // never move a venv or delete its source when cleaning the new data root.
    if (typeof value.previousRuntimeRoot === 'string' && path.isAbsolute(value.previousRuntimeRoot)
      && typeof value.directory === 'string' && /^(?:env|runtimes\/runtime-[0-9a-f-]{36})$/.test(value.directory)) {
      const selected = path.join(value.previousRuntimeRoot, ...value.directory.split('/'))
      if (existsSync(selected)) return selected
    }
    if (typeof value.directory === 'string' && /^runtime-[0-9a-f-]{36}$/.test(value.directory)) {
      const selected = path.join(root, 'runtimes', value.directory)
      if (existsSync(selected)) return selected
    }
  } catch { /* Older installations use root/env. */ }
  return path.join(root, 'env')
}

export async function linkMigratedEnvironment(sourceRoot: string, destinationRoot: string): Promise<string | null> {
  const active = activeEnvironment(sourceRoot)
  if (!existsSync(active)) return null
  const runtimeVersion = /^runtime-[0-9a-f-]{36}$/.test(path.basename(active)) && path.basename(path.dirname(active)) === 'runtimes'
  const previousRuntimeRoot = runtimeVersion ? path.dirname(path.dirname(active)) : path.dirname(active)
  const directory = runtimeVersion ? `runtimes/${path.basename(active)}` : 'env'
  if (!runtimeVersion && path.basename(active) !== 'env') throw new Error('INVALID_MIGRATED_ENVIRONMENT')
  await mkdir(destinationRoot, { recursive: true })
  const pointer = path.join(destinationRoot, 'active-environment.json')
  const contents = JSON.stringify({ schema: 1, previousRuntimeRoot, directory })
  // The destination is not active until settings commit. Exclusive creation
  // also works on exFAT and cannot replace an unrelated installation's pointer.
  const handle = await open(pointer, 'wx')
  try {
    await handle.writeFile(contents, 'utf8')
  } catch (error) {
    await handle.close()
    await rm(pointer, { force: true })
    throw error
  }
  await handle.close()
  return contents
}

export async function createEnvironment(root: string): Promise<string> {
  const directory = path.join(root, 'runtimes', `runtime-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  return directory
}

/** Venvs stay at their original absolute paths; only the tiny pointer is replaced. */
export async function activateEnvironment(root: string, directory: string): Promise<void> {
  if (path.dirname(directory) !== path.join(root, 'runtimes') || !/^runtime-[0-9a-f-]{36}$/.test(path.basename(directory))) throw new Error('INVALID_RUNTIME_DIRECTORY')
  const destination = path.join(root, 'active-environment.json')
  const temporary = `${destination}.${randomUUID()}.part`
  try {
    await writeFile(temporary, JSON.stringify({ schema: 1, directory: path.basename(directory) }), 'utf8')
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}
