// Exercise the packaged main/preload/renderer/SQLite chain with isolated data.
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

if (process.platform !== 'win32') throw new Error('WINDOWS_QUALIFICATION_REQUIRES_WINDOWS')
const directory = path.resolve(process.argv[2] || 'release-unsigned')
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const resources = path.join(directory, 'win-unpacked/resources')
const buildRoot = path.resolve(process.argv[3] || '.')
const builderRequire = createRequire(import.meta.resolve('electron-builder'))
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar')
let verifiedBuildFiles = 0
async function verifyBuild(relative = 'out') {
  for (const entry of await readdir(path.join(buildRoot, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name)
    if (entry.isDirectory()) await verifyBuild(file)
    else {
      if (!asar.extractFile(path.join(resources, 'app.asar'), file).equals(await readFile(path.join(buildRoot, file)))) throw new Error(`PACKAGED_BUILD_MISMATCH:${file}`)
      verifiedBuildFiles++
    }
  }
}
await verifyBuild()
for (const file of ['app.asar', 'bin/uv.exe', 'bin/ffmpeg.exe', 'bin/ffprobe.exe', 'audio-host/win32-x64/bandbuddy-audio-host.exe', 'system-helper/win32-x64/bandbuddy-system-helper.exe', 'prerequisites/vc_redist.x64.exe', 'model-catalog.json', 'runtime-catalog/win32-x64-cpu.json', 'runtime-catalog/win32-x64-cu128.json', 'runtime-catalog/win32-x64-cu130.json', 'worker/worker.py']) await access(path.join(resources, file))
const helper = path.join(resources, 'system-helper/win32-x64/bandbuddy-system-helper.exe')
const self = spawnSync(helper, ['self-test'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
if (self.status !== 0 || !JSON.parse(self.stdout).ok) throw new Error('PACKAGED_SYSTEM_HELPER_FAILED')
const signature = spawnSync(helper, ['signature', path.join(resources, 'prerequisites/vc_redist.x64.exe')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
const microsoft = JSON.parse(signature.stdout || '{}')
if (signature.status !== 0 || microsoft.status !== 'Valid' || !/(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)/.test(microsoft.subject)) throw new Error('PACKAGED_MICROSOFT_SIGNATURE_FAILED')

async function smoke(executable, name) {
  const data = path.join(directory, 'qualification', `中文 ${name}-${randomUUID()}`)
  await mkdir(data, { recursive: true })
  const environment = { ...process.env, BANDBUDDY_SMOKE: '1', BANDBUDDY_TEST_ROOT: data, ELECTRON_RENDERER_URL: '' }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.BANDBUDDY_BENCHMARK
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: data, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-128_000) })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-128_000) })
    const timer = setTimeout(() => {
      if (child.pid) spawnSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 10_000 })
      reject(new Error(`PACKAGED_SMOKE_TIMEOUT:${name}:${stderr.slice(-2000)}`))
    }, 120_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`PACKAGED_SMOKE_EXIT:${code}:${stdout.slice(-2000)}:${stderr.slice(-2000)}`)) })
  })
  await writeFile(path.join(data, 'smoke.log'), output.stdout + '\n' + output.stderr)
  const line = output.stdout.split(/\r?\n/).find(value => value.startsWith('BAND_BUDDY_SMOKE '))
  const result = line ? JSON.parse(line.slice('BAND_BUDDY_SMOKE '.length)) : JSON.parse(await readFile(path.join(data, 'appdata/smoke-result.json'), 'utf8').catch(() => 'null'))
  if (result?.apiType !== 'object' || !result.ffmpegReady || result.songs !== 0 || result.environment?.startup !== 'ready' || !result.namespaces.includes('environment')) throw new Error(`PACKAGED_SMOKE_FAILED:${name}:${JSON.stringify(result)}`)
  return { name, result }
}
const report = { version, at: new Date().toISOString(), verifiedBuildFiles, microsoftPrerequisite: microsoft.status, results: [] }
report.results.push(await smoke(path.join(directory, 'win-unpacked/BandBuddy.exe'), 'installed-payload'))
report.results.push(await smoke(path.join(directory, `BandBuddy-${version}-x64-portable.exe`), 'portable'))
await writeFile(path.join(directory, 'environment-smoke.json'), JSON.stringify(report, null, 2))
console.log('Verified packaged SQLite, preload, environment IPC, media tools, desktop lyrics and Portable startup with isolated Chinese paths.')
