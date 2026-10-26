// Exercise the built worklet in Electron with the application's actual CSP.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const root = path.resolve(import.meta.dirname, '..')

if (!process.versions.electron) {
  const electron = (await import('electron')).default
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-arsenal-output-'))
  const { build } = await import('vite')
  await build({ configFile: false, logLevel: 'error', build: { ssr: path.join(root, 'src/main/arsenal-output.ts'), outDir: directory,
    emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'transport.mjs' } } } })
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
  const { app, BrowserWindow, protocol } = await import('electron')
  app.on('window-all-closed', () => {})
  const directory = process.env.ARSENAL_OUTPUT_TEST_ROOT
  if (!directory) throw new Error('Run this test through Node.js')
  app.setPath('userData', path.join(directory, 'profile'))
  protocol.registerSchemesAsPrivileged([{ scheme: 'bandbuddy-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
  await app.whenReady()
  const { ArsenalOutputTransport } = await import(pathToFileURL(path.join(directory, 'transport.mjs')).href)
  const receiver = await nativeReceiver()
  const segments = [[]]
  const transport = new ArsenalOutputTransport(async packet => {
    if (packet.reset) segments.push([])
    else segments.at(-1).push(packet.samples)
    return receiver.rpc('arsenalPcm', packet)
  })
  protocol.handle('bandbuddy-media', request => transport.response(request))
  const endpoint = transport.open(0)
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  let exitCode = 0
  try {
    const renderer = path.join(root, 'out/renderer')
    const html = await readFile(path.join(renderer, 'index.html'), 'utf8')
    const csp = html.match(/content="(default-src[^"]+)"/)?.[1]
    if (!csp) throw new Error('Application CSP not found')
    let moduleUrl, workerUrl
    for (const name of await readdir(path.join(renderer, 'assets'))) {
      if (!name.endsWith('.js')) continue
      const file = path.join(renderer, 'assets', name)
      const source = await readFile(file, 'utf8')
      if (!source.includes('bandbuddy-arsenal-output') || !source.includes('.addModule(')) continue
      // Vite emits URL imports as a variable, while the old loader used new URL inline.
      const reference = source.match(/new URL\((["'`])([^"'`]*native-output\.worklet[^"'`]*|data:text\/javascript[^"'`]*)\1/)?.[2]
      if (!reference) throw new Error('Built Arsenal worklet reference not found')
      moduleUrl = new URL(reference, pathToFileURL(file)).href
      const workerReference = source.match(/new URL\((["'`])([^"'`]*native-output\.worker[^"'`]*)\1/)?.[2]
      if (!workerReference) throw new Error('Built Arsenal output worker missing')
      workerUrl = new URL(workerReference, pathToFileURL(file)).href
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
        const oscillator = context.createOscillator();
        oscillator.connect(node); oscillator.start();
        const packets = [];
        node.port.onmessage = event => packets.push(event.data);
        node.port.postMessage({ enabled: true, epoch: 1 });
        await context.resume();
        await new Promise(resolve => setTimeout(resolve, 180));
        // Emulate recording finalization/UI work while the audio thread runs.
        const until = performance.now() + 300;
        while (performance.now() < until) {}
        await new Promise(resolve => setTimeout(resolve, 100));
        if (packets.length !== 4) throw new Error('Unbounded or missing worklet packets: ' + packets.length);
        const resumeTime = context.currentTime;
        node.port.postMessage({ ack: true, epoch: 1 });
        await new Promise(resolve => setTimeout(resolve, 100));
        if (packets.length !== 5 || packets[4].time < resumeTime - .03) throw new Error('Worklet replayed stale audio after backpressure');
        if (!packets[4].samples.some(value => Math.abs(value) > .01)) throw new Error('Worklet did not transport actual audio');
        node.port.postMessage({ enabled: false, epoch: 2 });
        oscillator.stop();
        node.disconnect();
        const audio = new AudioWorkletNode(context, 'bandbuddy-arsenal-output', { outputChannelCount: [2] });
        const worker = new Worker(${JSON.stringify(workerUrl)}, { type: 'module' });
        try {
          const reply = predicate => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker response timed out')), 6000);
            const receive = ({data}) => {
              if (data.error || predicate(data)) { clearTimeout(timer); worker.removeEventListener('message', receive); data.error ? reject(new Error(data.error)) : resolve(data); }
            };
            worker.addEventListener('message', receive);
          });
          const ready = reply(data => data.ready);
          worker.postMessage({ port: audio.port, url: ${JSON.stringify(endpoint)}, sampleRate: context.sampleRate }, [audio.port]);
          await ready;
          const signal = context.createOscillator(), gain = context.createGain();
          gain.gain.value = .12; signal.frequency.value = 440;
          signal.connect(gain).connect(audio).connect(context.destination); signal.start();
          worker.postMessage({ control: { enabled: true, epoch: 1 } });
          // UI work must neither starve native playback nor splice out samples.
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 180));
            const until = performance.now() + 110;
            while (performance.now() < until) {}
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          worker.postMessage({ control: { enabled: false, epoch: 2 } });
          const reset = reply(data => data.id === 1); worker.postMessage({ reset: true, id: 1 }); await reset;
          worker.postMessage({ control: { enabled: true, epoch: 3 } });
          await new Promise(resolve => setTimeout(resolve, 200));
          worker.postMessage({ control: { enabled: false, epoch: 4 } });
          const close = reply(data => data.id === 2); worker.postMessage({ reset: true, id: 2 }); await close;
          signal.stop(); gain.disconnect();
        } finally { worker.terminate(); audio.disconnect(); }
        return { loaded: true, sampleRate: context.sampleRate, silentSink: context.sinkId.type === 'none', boundedPackets: 4, uiStalls: 10, workerRestarted: true };
      } catch (error) { return { loaded: false, error: String(error) }; }
      finally { await context.close(); }
    })()`)
    if (!result.loaded) throw new Error(`Arsenal output failed under production CSP: ${result.error}`)
    const continuity = segments.filter(packets => packets.length).map(packets => {
      let previous, maximumSampleStep = 0, sampleJumps = 0, frames = 0, peak = 0
      for (const packet of packets) for (let i = 0; i < packet.length; i += 2) {
        const sample = packet[i]; frames++; peak = Math.max(peak, Math.abs(sample))
        if (previous !== undefined) { const step = Math.abs(sample - previous); maximumSampleStep = Math.max(maximumSampleStep, step); if (step > .012) sampleJumps++ }
        previous = sample
      }
      return { frames, peak, maximumSampleStep, sampleJumps }
    })
    if (continuity.length !== 2 || continuity[0].frames < result.sampleRate * 2.8 || continuity.some(c => c.peak < .1 || c.sampleJumps))
      throw new Error(`Discontinuous worker audio: ${JSON.stringify(continuity)}`)
    if (moduleUrl.startsWith('data:')) throw new Error('Arsenal output must be emitted as a separate script asset')
    const native = receiver.diagnostics()
    if (native.pcmUnderruns || native.invalidSamples) throw new Error(`Native output starvation: ${JSON.stringify(native)}`)
    console.log(JSON.stringify({ ...result, moduleUrl, workerUrl, continuity, native }))
    console.log('PASS: built audio worker preserves PCM through 10 UI stalls, monitor restart and bus reset under production CSP')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    window.destroy()
    await receiver.close()
    app.exit(exitCode)
  }
}

async function nativeReceiver() {
  const executable = path.join(root, 'resources/audio-host', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'bandbuddy-audio-host.exe' : 'bandbuddy-audio-host')
  // The actual native parser, resampler, PCM FIFO and output callback run with
  // a simulated device: tests never emit a signal through the user's speakers.
  const child = spawn(executable, ['--simulate'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout }), pending = new Map()
  let sequence = 0, meter, errors = ''
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000) })
  child.on('error', error => { for (const entry of pending.values()) entry.reject(error) })
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.event === 'meter') meter = message.data
    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer); pending.delete(message.id)
    if (message.ok) entry.resolve(message.result); else entry.reject(new Error(message.error))
  })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${errors}`)) }, 5000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  const devices = await rpc('devices'), device = devices[0]
  await rpc('startTest', { backend: device.backend, inputDeviceId: device.id, outputDeviceId: device.id,
    inputChannels: [0], sampleRate: 44100, bufferFrames: 256, monitorMode: 0, outputOnly: true })
  return { rpc, diagnostics: () => {
    if (!meter) throw new Error('Missing native output diagnostics')
    return { outputRate: 44100, pcmUnderruns: meter.pcmUnderruns, invalidSamples: meter.diagnostics.invalidSamples }
  }, close: async () => { try { await rpc('stopTest') } finally { child.kill(); lines.close() } } }
}
