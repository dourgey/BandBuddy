// Run the native/SQLite recording integration with the same ABI as the app.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import electron from 'electron'
const require = createRequire(import.meta.url)
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const child = spawn(electron, [vitest, 'run', 'tests/recording-roundtrip.test.ts', '--maxWorkers=1', ...process.argv.slice(2).filter(arg => arg !== '--')], {
  cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true
})
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
