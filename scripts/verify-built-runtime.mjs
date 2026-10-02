import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandboxModules = new Set(['electron', 'events', 'node:events', 'timers', 'node:timers', 'url', 'node:url'])

export async function verifyBuiltRuntime(directory = root) {
  for (const [entry, api] of [['index', 'bandbuddy'], ['lyrics', 'desktopLyrics']]) {
    const file = path.join(directory, `out/preload/${entry}.cjs`)
    const source = await readFile(file, 'utf8')
    for (const [, , dependency] of source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      if (!sandboxModules.has(dependency)) throw new Error(`SANDBOX_PRELOAD_EXTERNAL_MODULE:${entry}:${dependency}; each preload must be a standalone bundle`)
    }
    if (/\b(?:import|export)\s[^;\n]*?\bfrom\s*['"]|\bimport\s*\(/.test(source)) throw new Error(`SANDBOX_PRELOAD_MODULE_SPLIT:${entry}`)
    if (!new RegExp(`exposeInMainWorld\\s*\\(\\s*(['"])${api}\\1`).test(source)) throw new Error(`SANDBOX_PRELOAD_API_MISSING:${entry}:${api}`)
  }
  const mainRoot = path.join(directory, 'out/main')
  // Multiple main entries legitimately put external imports in shared chunks.
  // Only dependencies reachable from the actual application entry count.
  const external = new Set()
  const visited = new Set()
  async function inspectImports(file) {
    if (visited.has(file)) return
    visited.add(file)
    const code = await readFile(file, 'utf8')
    const dependencies = [
      ...code.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g),
      ...code.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g)
    ].map(match => match[1])
    for (const dependency of dependencies) {
      if (dependency.startsWith('.')) await inspectImports(path.resolve(path.dirname(file), dependency))
      else external.add(dependency)
    }
  }
  await inspectImports(path.join(mainRoot, 'index.js'))
  for (const name of ['electron', 'better-sqlite3']) {
    if (!external.has(name)) throw new Error(`MAIN_NATIVE_DEPENDENCY_NOT_EXTERNAL:${name}`)
  }
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await inspect(file)
      else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
        const code = await readFile(file, 'utf8')
        if (/\b(?:require_electron|require_bindings)\b|node_modules\/[^\n]*(?:\/electron\/index\.js|\/better-sqlite3\/lib\/|\/bindings\/)/.test(code)) throw new Error(`MAIN_NATIVE_IMPLEMENTATION_BUNDLED:${path.relative(mainRoot, file)}`)
      }
    }
  }
  await inspect(mainRoot)
  await readFile(path.join(mainRoot, 'analysis-worker.js'), 'utf8')
  await readFile(path.join(mainRoot, 'database-boot-worker.js'), 'utf8')
  return { preloads: ['index.cjs', 'lyrics.cjs'], external: ['electron', 'better-sqlite3'], analysisWorker: true, databaseWorker: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyBuiltRuntime(process.argv[2] ? path.resolve(process.argv[2]) : root)
    .then(() => console.log('Verified standalone sandbox preloads, external native main dependencies and analysis/database workers.'))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
