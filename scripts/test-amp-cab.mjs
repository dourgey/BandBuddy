import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const executable = path.join(root, 'native/audio-host/build', `${process.platform}-${process.arch}`, 'effects', ...(process.platform === 'win32' ? ['Release'] : []), `bandbuddy-amp-cab-test${process.platform === 'win32' ? '.exe' : ''}`)
for (const [command, args] of [[executable, []], [process.execPath, [path.join(root, 'scripts/test-whitebox.mjs'), '--amp-cab-only']]]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status) process.exit(result.status)
}
