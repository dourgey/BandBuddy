// Real release gate: uses the same downloader/installer and isolated private directories.
import { build } from 'vite'
import { builtinModules } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const preferredDevice = process.env.BANDBUDDY_VERIFY_DEVICE || 'cpu'
if (!['cpu', 'cuda', 'auto'].includes(preferredDevice)) throw new Error('BANDBUDDY_VERIFY_DEVICE must be cpu, cuda or auto')
const root = process.cwd(), directory = path.join(root, '.runtime-verification')
await mkdir(directory, { recursive: true })
const source = path.join(directory, 'verify.ts')
await writeFile(source, `
import { app } from 'electron'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { AppPaths } from '../src/main/paths.js'
import { BandBuddyDatabase } from '../src/main/database.js'
import { RuntimeManager } from '../src/main/runtime.js'
import { Logger } from '../src/main/logger.js'
app.setName('BandBuddy environment qualification')
app.setPath('userData', path.join(process.env.BANDBUDDY_TEST_ROOT!, 'appdata'))
void app.whenReady().then(async () => {
const paths = new AppPaths(); paths.ensure()
const database = new BandBuddyDatabase(paths)
const preferredDevice = (process.env.BANDBUDDY_VERIFY_DEVICE || 'cpu') as 'cpu' | 'cuda' | 'auto'
database.saveSettings({ ...database.getSettings(), preferredDevice })
const logger = new Logger(paths.logsRoot), runtime = new RuntimeManager(paths, database, logger)
let last = 0, stage = ''
runtime.onChange(info => { if (info.stage !== stage || Date.now() - last > 3000) { stage = info.stage; last = Date.now(); console.log(JSON.stringify({ status: info.status, stage, received: info.downloadedBytes, total: info.downloadTotalBytes })) } })
try {
  const previous = await runtime.detect()
  const installed = previous.status === 'ready' ? await runtime.repair() : await runtime.install()
  if (installed.status !== 'ready' || installed.error) throw new Error(installed.error ?? 'INSTALLATION_NOT_READY')
  if (preferredDevice === 'cuda' && installed.selectedDevice !== 'cuda') throw new Error('REQUESTED_GPU_NOT_QUALIFIED')
  const inference = await runtime.runWorker(['probe', '--model-root', database.getSettings().modelRoot, '--full-self-test', '--device', installed.selectedDevice], undefined, 30 * 60_000, message => { if (message.type === 'progress') console.log(message.message) })
  if (inference.code !== 0 || !inference.result.selfTest?.ok || !inference.result.selfTest?.modelInference || inference.result.selfTest?.guitarQualities?.length !== 3) throw new Error('FULL_INFERENCE_FAILED:' + JSON.stringify(inference))
  const result = { target: process.platform + '-' + process.arch, at: new Date().toISOString(), runtime: installed, inference: inference.result, downloads: runtime.downloadDiagnostics() }
  await writeFile(path.join(process.env.BANDBUDDY_TEST_ROOT!, 'qualification.json'), JSON.stringify(result, null, 2))
  console.log('BAND_BUDDY_RUNTIME_QUALIFIED ' + JSON.stringify(inference.result.selfTest))
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await runtime.shutdown(); await logger.flush(); database.close(); app.exit(process.exitCode || 0) }
}).catch(error => { console.error(error); app.exit(1) })
`, 'utf8')
const dependencies = Object.keys(JSON.parse(await readFile('package.json', 'utf8')).dependencies)
await build({ configFile: false, resolve: { alias: { '@shared': path.join(root, 'packages/shared/src') } }, build: { target: 'node24', outDir: directory, emptyOutDir: false, minify: false, lib: { entry: source, formats: ['es'], fileName: () => 'verify.mjs' }, rollupOptions: { external: id => id.startsWith('node:') || builtinModules.includes(id) || ['electron', ...dependencies].some(name => id === name || id.startsWith(name + '/')) } } })
const testRoot = process.env.BANDBUDDY_TEST_ROOT || path.join(directory, process.platform + '-' + process.arch)
const env = { ...process.env, BANDBUDDY_TEST_ROOT: testRoot }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [path.join(directory, 'verify.mjs')], { cwd: root, env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
