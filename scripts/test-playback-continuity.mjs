// Real Electron MP3 decoding, mixer and AudioWorklet output capture. Timestamp
// jitter and UI stalls are injected; PCM rendering and resampling are real.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const frequencies = { vocals: 220, drums: 277, bass: 330, guitar: 440, piano: 554, other: 660 }
if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const directory = await mkdtemp(path.join(tmpdir(), 'BandBuddy playback continuity-'))
  let server
  try {
    await writeFile(path.join(directory, 'probe.js'), `
      class Probe extends AudioWorkletProcessor {
        constructor() {
          super(); this.enabled = false;
          this.port.onmessage = ({data}) => {
            if (data === 'start') {
              this.previous = null; this.frames = 0; this.peak = 0; this.maxStep = 0;
              this.jumps = 0; this.silentBlocks = 0; this.nonfinite = 0; this.enabled = true;
            } else {
              this.enabled = false;
              this.port.postMessage({frames:this.frames, peak:this.peak, maxStep:this.maxStep,
                jumps:this.jumps, silentBlocks:this.silentBlocks, nonfinite:this.nonfinite});
            }
          };
        }
        process(inputs) {
          if (!this.enabled) return true;
          let energy = 0;
          for (const sample of inputs[0]?.[0] ?? []) {
            this.frames++; if (!Number.isFinite(sample)) this.nonfinite++;
            this.peak = Math.max(this.peak, Math.abs(sample));
            if (this.previous !== null) {
              const step = Math.abs(sample - this.previous); this.maxStep = Math.max(this.maxStep, step);
              // Six 0.04-amplitude sines (220..660 Hz) have a combined normal
              // step < .014 at 48 kHz. Distinct frequencies avoid cancellation.
              if (step > .025) this.jumps++;
            }
            this.previous = sample; energy += sample * sample;
          }
          if (energy < 1e-12) this.silentBlocks++;
          return true;
        }
      }
      registerProcessor('continuity', Probe);
    `)
    const input = path.join(directory, 'source.wav')
    for (const [type, frequency] of Object.entries(frequencies)) {
      await writeFile(input, wave(frequency))
      execFileSync(path.join(root, 'resources/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
        ['-v', 'error', '-i', input, '-ar', '44100', '-ac', '2', '-b:a', '320k', path.join(directory, type + '.mp3')], { windowsHide: true })
    }
    server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, directory] } } })
    await server.listen()
    const electron = (await import('electron')).default
    const env = { ...process.env, CONTINUITY_ROOT: directory, CONTINUITY_URL: server.resolvedUrls.local[0] }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 90_000)
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1))
    }).finally(() => clearTimeout(timer))
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
} else {
  void verify().catch(error => { console.error(error); process.exit(1) })
}

function wave(frequency) {
  const rate = 48000, frames = rate * 24, bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28)
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
  for (let frame = 0; frame < frames; frame++) bytes.writeFloatLE(.04 * Math.sin(frame * 2 * Math.PI * frequency / rate), 44 + frame * 4)
  return bytes
}

async function verify() {
  const { app, BrowserWindow, protocol } = await import('electron')
  const directory = process.env.CONTINUITY_ROOT
  if (!directory) throw new Error('Run through Node.js')
  app.setPath('userData', path.join(directory, 'profile'))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  protocol.registerSchemesAsPrivileged([{ scheme: 'bandbuddy-media', privileges: {
    standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true
  } }])
  await app.whenReady()
  const sources = new Map(await Promise.all(Object.keys(frequencies).map(async type => [type + '.mp3', await readFile(path.join(directory, type + '.mp3'))])))
  protocol.handle('bandbuddy-media', request => {
    const mp3 = sources.get(new URL(request.url).pathname.slice(1))
    if (!mp3) return new Response('Not found', { status: 404 })
    return new Response(mp3, { headers: {
    'Content-Type': 'audio/mpeg', 'Content-Length': String(mp3.length), 'Access-Control-Allow-Origin': '*'
    } })
  })
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const consoleErrors = []
  window.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message) })
  app.on('window-all-closed', () => {})
  let exitCode = 0
  try {
    await window.loadURL(process.env.CONTINUITY_URL + '?fixtures')
    const result = await window.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify('/@fs/' + path.join(directory, 'probe.js').replaceAll('\\', '/'))})`)
    if (consoleErrors.length) throw new Error(consoleErrors.join('\n'))
    console.log(JSON.stringify({ ...result, boundary: 'Electron silent sink; no physical soundcard/listening acceptance' }, null, 2))
    console.log('Playback continuity regression passed')
  } catch (error) { console.error(error); exitCode = 1 }
  finally { window.destroy(); app.exit(exitCode) }
}

async function exercise(probeUrl) {
  const { MultiTrackAudioEngine } = await import('/src/audio-engine.ts')
  const { fixtureDetail, fixtureSongs } = await import('/src/fixtures.ts')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const require = (condition, message) => { if (!condition) throw new Error(message) }
  const Context = window.AudioContext
  window.AudioContext = class extends Context {
    constructor(options) { super({ ...options, sinkId: { type: 'none' } }) }
    setSinkId() { return Promise.resolve() }
  }
  const seeks = [], rates = []
  for (const [name, log] of [['currentTime', seeks], ['playbackRate', rates]]) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)
    Object.defineProperty(HTMLMediaElement.prototype, name, { ...descriptor, set(value) {
      log.push({ source: this.src, value }); descriptor.set.call(this, value)
    } })
  }
  const results = []
  for (const [rate, pitch] of [[1, 0], [.75, 0], [1.25, 0], [1, 5], [.75, -3]]) {
    const song = fixtureDetail(fixtureSongs[0])
    song.durationMs = 24000; song.recordingTracks = []; song.recordingTakes = []
    song.practice = { ...song.practice, positionMs: 0, playbackRate: rate, pitchSemitones: pitch, masterGainDb: 0,
      metronomeEnabled: false, countInBeats: 0, loopEnabled: false, guitarSplitEnabled: false, vocalSplitEnabled: false }
    song.practice.tracks = song.practice.tracks.map(track => ({ ...track, gainDb: 0, muted: false, solo: false }))
    song.stems = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'].map(type => ({
      ...song.stems[0], type, encodingGain: 1, mediaUrl: 'bandbuddy-media://backing/' + type + '.mp3'
    }))
    const engine = new MultiTrackAudioEngine({ applySongEq: true }), errors = []
    engine.onError(error => errors.push(String(error)))
    try {
      await engine.load(song)
      await engine.context.audioWorklet.addModule(probeUrl)
      const tap = new AudioWorkletNode(engine.context, 'continuity')
      engine.master.connect(tap).connect(engine.context.destination)
      const capture = async action => {
        tap.port.postMessage('start'); await action()
        const audio = await new Promise(resolve => { tap.port.onmessage = event => resolve(event.data); tap.port.postMessage('stop') })
        require(audio.frames > 48000 && audio.peak > .05 && audio.peak < 1 && audio.nonfinite === 0
          && audio.jumps === 0 && audio.silentBlocks === 0, 'Audio discontinuity: ' + JSON.stringify({ rate, pitch, audio }))
        return audio
      }
      await engine.play(); await sleep(600)
      const target = engine.tracks.get('bass').element
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime'), started = performance.now()
      Object.defineProperty(target, 'currentTime', { configurable: true,
        get() { return descriptor.get.call(this) + (Math.floor((performance.now() - started) / 80) % 2 ? .045 : -.045) * rate },
        set(value) { descriptor.set.call(this, value) }
      })
      seeks.length = 0; rates.length = 0
      const jitter = await capture(async () => {
        for (let stall = 0; stall < 10; stall++) {
          await sleep(180)
          const until = performance.now() + 110
          while (performance.now() < until) { /* Deliberately block UI, not the audio thread. */ }
        }
      })
      require(seeks.length === 0 && rates.length === 0, 'Timestamp jitter changed media transport')
      delete target.currentTime
      let recovery
      if (rate === 1 && pitch === 0) {
        target.pause(); await sleep(450); await target.play(); await sleep(100)
        seeks.length = 0; rates.length = 0
        recovery = await capture(() => sleep(3200))
        const drift = Math.abs(target.currentTime - engine.tracks.get('vocals').element.currentTime)
        require(seeks.length === 1 && rates.length === 0 && drift < .035, 'Sustained offset failed to recover: ' + JSON.stringify({ seeks, rates, drift,
          clock: engine.mediaClocks.get(target), pending: engine.resyncs.size, contextTime: engine.context.currentTime,
          media: [...engine.tracks.values()].filter(track => track.element.src).map(({element}) => ({ time: element.currentTime, paused: element.paused, seeking: element.seeking, ready: element.readyState })) }))
        engine.pause(); const stopped = target.currentTime; await sleep(100)
        require(target.currentTime === stopped, 'Pause failed')
        engine.seek(1000); await engine.play(); await sleep(200)
        require(target.currentTime > 1 && !target.paused, 'Seek/resume failed')
      }
      require(errors.length === 0, errors.join('\n'))
      results.push({ rate, pitch, jitter, recovery })
    } finally { engine.destroy() }
  }
  return { results }
}
