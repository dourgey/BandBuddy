// Exercise the production Web Audio EQ in Chromium, without opening a device.
import { build } from 'vite'
import electron from 'electron'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const bundle = await build({ configFile: false, logLevel: 'error',
  resolve: { alias: { '@shared': path.resolve('packages/shared/src') } },
  build: { write: false, minify: false, lib: { entry: path.resolve('src/renderer/src/song-equalizer.ts'), name: 'EqDsp', formats: ['iife'] } }
})
const code = bundle[0].output.find(item => item.type === 'chunk').code
async function test() {
  const results = []
  for (const sampleRate of [44100, 48000, 96000]) {
    const context = new OfflineAudioContext(2, sampleRate * 3, sampleRate)
    const response = new EqDsp.EqResponse(context), bus = new EqDsp.SongEqBus(context, 2)
    const input = context.createBuffer(2, sampleRate * 3, sampleRate)
    for (let i = 0; i < input.length; i++) {
      const value = .15 * Math.sin(i * 2 * Math.PI * 440 / sampleRate)
      input.getChannelData(0)[i] = value; input.getChannelData(1)[i] = -value
    }
    const source = context.createBufferSource(); source.buffer = input
    source.connect(bus.input); bus.output.connect(context.destination)
    const state = { enabled: true, mode: 'parametric', graphicGains: Array(10).fill(0), nodes: [] }
    bus.apply(response.configure(state), true); source.start()
    // 100 edits per second, faster than the 30 ms parameter ramp. Include
    // overlap, high Q, opposite gain extremes, node removal and bypass.
    const edits = []
    for (let i = 1; i < 290; i++) edits.push(context.suspend(i / 100).then(() => {
      const nodes = Array.from({ length: i % 31 === 0 ? 0 : 8 }, (_, n) => ({ id: String(n),
        frequency: 20 * 1000 ** (((i * 7 + n * 13) % 200) / 199), gainDb: i % 2 ? 12 : -12, q: i % 3 ? 12 : .2 }))
      bus.apply(response.configure({ ...state, enabled: i % 23 !== 0, nodes }))
      return context.resume()
    }))
    const rendered = await context.startRendering(); await Promise.all(edits)
    const left = rendered.getChannelData(0), right = rendered.getChannelData(1)
    let peak = 0, maximumSampleStep = 0, stereoError = 0, maximumStepTime = 0
    for (let i = 1; i < left.length; i++) {
      if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Nonfinite EQ output')
      peak = Math.max(peak, Math.abs(left[i]))
      if (Math.abs(left[i] - left[i - 1]) > maximumSampleStep) { maximumSampleStep = Math.abs(left[i] - left[i - 1]); maximumStepTime = i / sampleRate }
      stereoError = Math.max(stereoError, Math.abs(left[i] + right[i]))
    }
    if (peak >= 1 || maximumSampleStep > .03 || stereoError > 1e-6) throw new Error(JSON.stringify({ sampleRate, peak, maximumSampleStep, maximumStepTime, stereoError }))
    results.push({ sampleRate, edits: edits.length, peak, maximumSampleStep, maximumStepTime, stereoError })
    bus.destroy(); response.destroy()
  }
  return results
}
const root = await mkdtemp(path.join(tmpdir(), 'bandbuddy-eq-'))
try {
  const script = path.join(root, 'run.cjs')
  // The child runs inside Electron, where require('electron') is built in.
  await writeFile(script, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('about:blank');
  const results = await window.webContents.executeJavaScript(${JSON.stringify(code + '\n(' + test.toString() + ')()')});
  console.log(JSON.stringify({ ok: true, webAudioEq: results })); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const status = await new Promise((resolve, reject) => {
    const child = spawn(electron, [script], { env, windowsHide: true, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Web Audio EQ test timed out')) }, 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  if (status !== 0) throw new Error(`Web Audio EQ test exited with ${status}`)
} finally { await rm(root, { recursive: true, force: true }) }
