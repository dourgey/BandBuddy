// Exercise the built worklet in Electron with the application's actual CSP.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')

if (!process.versions.electron) {
  const electron = (await import('electron')).default
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-arsenal-output-'))
  const env = { ...process.env, ARSENAL_OUTPUT_TEST_ROOT: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 30_000)
  child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.once('exit', async code => {
    clearTimeout(timer)
    process.exitCode = code ?? 1
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
} else {
  void verifyWorklet().catch(error => { console.error(error); process.exit(1) })
}

async function verifyWorklet() {
  const { app, BrowserWindow } = await import('electron')
  app.on('window-all-closed', () => {})
  const directory = process.env.ARSENAL_OUTPUT_TEST_ROOT
  if (!directory) throw new Error('Run this test through Node.js')
  app.setPath('userData', path.join(directory, 'profile'))
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  let exitCode = 0
  try {
    const renderer = path.join(root, 'out/renderer')
    const html = await readFile(path.join(renderer, 'index.html'), 'utf8')
    const csp = html.match(/content="(default-src[^"]+)"/)?.[1]
    if (!csp) throw new Error('Application CSP not found')
    let moduleUrl
    for (const name of await readdir(path.join(renderer, 'assets'))) {
      if (!name.endsWith('.js')) continue
      const file = path.join(renderer, 'assets', name)
      const source = await readFile(file, 'utf8')
      if (!source.includes('bandbuddy-arsenal-output') || !source.includes('.addModule(')) continue
      // Vite emits URL imports as a variable, while the old loader used new URL inline.
      const reference = source.match(/new URL\((["'`])([^"'`]*native-output\.worklet[^"'`]*|data:text\/javascript[^"'`]*)\1/)?.[2]
      if (!reference) throw new Error('Built Arsenal worklet reference not found')
      moduleUrl = new URL(reference, pathToFileURL(file)).href
      break
    }
    if (!moduleUrl) throw new Error('Built Arsenal output loader missing')
    const page = path.join(directory, 'worklet.html')
    await writeFile(page, `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    await window.loadFile(page)
    const result = await window.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext({ sinkId: { type: 'none' } });
      try {
        await context.audioWorklet.addModule(${JSON.stringify(moduleUrl)});
        const node = new AudioWorkletNode(context, 'bandbuddy-arsenal-output', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
        });
        node.connect(context.destination);
        node.port.postMessage({ enabled: true });
        node.port.postMessage({ enabled: false });
        node.disconnect();
        return { loaded: true, sampleRate: context.sampleRate, silentSink: context.sinkId.type === 'none' };
      } catch (error) { return { loaded: false, error: String(error) }; }
      finally { await context.close(); }
    })()`)
    if (!result.loaded) throw new Error(`Arsenal output failed under production CSP: ${result.error}`)
    if (moduleUrl.startsWith('data:')) throw new Error('Arsenal output must be emitted as a separate script asset')
    console.log(JSON.stringify({ ...result, moduleUrl }))
    console.log('PASS: built Arsenal worklet loads and creates its audio node under production CSP')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    window.destroy()
    app.exit(exitCode)
  }
}
