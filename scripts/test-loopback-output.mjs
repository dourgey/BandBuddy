// Real Electron -> Loopback Pass-Thru -> CoreAudio capture, no mocked audio nodes.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deviceName = process.env.LOOPBACK_DEVICE_NAME || 'Loopback Audio'
const frequencies = [233, 347, 503, 647, 887, 1103, 1429, 1877]

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options })
    let stdout = '', stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout: ${command}`)) }, 120_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${command} exited ${code ?? signal}\n${stderr}\n${stdout}`))
      else resolve(stdout)
    })
    if (options.input) child.stdin.end(options.input)
  })
}

if (!process.versions.electron) {
  if (process.platform !== 'darwin') throw new Error('This hardware test requires macOS and an 8-channel Loopback Pass-Thru device')
  const directory = mkdtempSync(path.join(tmpdir(), 'bandbuddy-loopback-'))
  const { createServer } = await import('vite')
  const server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port: 0 } })
  try {
    const build = path.join(root, 'native/audio-host/build', `darwin-${process.arch}`)
    await run('clang++', [path.join(root, 'scripts/loopback-capture.cpp'), '-std=c++17', '-I', path.join(build, '_deps/rtaudio-src'),
      path.join(build, '_deps/rtaudio-build/librtaudio.a'), '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-o', path.join(directory, 'capture')])
    await server.listen()
    const electron = (await import('electron')).default
    await run(electron, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: {
      ...process.env, LOOPBACK_TEST_DIRECTORY: directory, LOOPBACK_TEST_URL: server.resolvedUrls.local[0]
    } })
  } finally {
    await server.close()
    rmSync(directory, { recursive: true, force: true })
  }
} else {
  // Electron emits ready after evaluating its ESM entry point. Do not await
  // whenReady at module scope or the test deadlocks before creating a window.
  void runElectronTest().catch((error) => { console.error(error); process.exit(1) })
}

async function runElectronTest() {
  const { app, BrowserWindow, ipcMain, session } = await import('electron')
  const directory = process.env.LOOPBACK_TEST_DIRECTORY
  app.setPath('userData', path.join(directory, 'profile'))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  await app.whenReady()
  // Only this isolated test origin; capture uses the explicitly named virtual device.
  session.defaultSession.setPermissionRequestHandler((_window, permission, callback) => callback(permission === 'media'))
  const host = path.join(root, 'resources/audio-host', `darwin-${process.arch}`, 'bandbuddy-audio-host')
  ipcMain.handle('loopback-test:prepare', async (_event, name) => {
    const output = await run(host, [], { input: `${JSON.stringify({ id: 1, method: 'prepareOutputDevice', params: { deviceName: name } })}\n` })
    const message = JSON.parse(output.trim())
    if (!message.ok) throw new Error(message.error)
    return message.result
  })
  const preload = path.join(directory, 'preload.cjs')
  writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('loopbackTest', { prepare: name => ipcRenderer.invoke('loopback-test:prepare', name) });`)
  const window = new BrowserWindow({ show: false, webPreferences: { preload, backgroundThrottling: false } })
  let exitCode = 0
  try {
    await window.loadURL(`${process.env.LOOPBACK_TEST_URL}?fixtures`)
    for (const mode of ['stereo', 'mono', 'pitch-up', 'pitch-down', 'pitch-up-solo', 'pitch-down-solo', 'reroute', 'solo', 'mute', 'device-switch', 'metronome']) {
      const setup = await window.webContents.executeJavaScript(`(${setupAudio.toString()})(${JSON.stringify({ deviceName, mode, frequencies })})`)
      if (setup.channels !== 8) throw new Error(`Expected 8 routable channels, got ${setup.channels}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const file = path.join(directory, `${mode}.f32`)
      const capture = JSON.parse(await run(path.join(directory, 'capture'), [deviceName, file]))
      const result = verifyCapture(readFileSync(file), capture, mode)
      console.log(JSON.stringify({ mode, ...capture, ...result }))
      await window.webContents.executeJavaScript('window.testEngine.destroy(); window.testUrls.forEach(URL.revokeObjectURL)')
    }
    console.log('PASS: real 8-channel Loopback routing, mono/stereo, pitch, live rerouting, mute/solo, device switching and metronome')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    window.destroy()
    app.exit(exitCode)
  }
}

async function setupAudio({ deviceName, mode, frequencies }) {
  const { MultiTrackAudioEngine } = await import('/src/audio-engine.ts')
  const { fixtureDetail, fixtureSongs } = await import('/src/fixtures.ts')
  window.bandbuddy.media.prepareOutputDevice = window.loopbackTest.prepare
  const song = fixtureDetail(fixtureSongs[0])
  const names = ['vocals', 'drums', 'bass', 'guitar']
  const urls = []
  function tone(index) {
    const channels = mode === 'mono' ? 1 : 2, rate = 44100, frames = rate * 15
    const buffer = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(buffer)
    const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
    view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true)
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, buffer.byteLength - 44, true)
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
      const phase = 2 * Math.PI * frequencies[index * 2 + channel] * frame / rate
      // Formant preservation intentionally reshapes isolated sine tones. Give
      // pitch tests a harmonic envelope, like an instrument, and keep the
      // production pitch/formant settings unchanged.
      let sample = Math.sin(phase)
      if (mode.startsWith('pitch-')) for (let harmonic = 2; harmonic <= 8; harmonic++) sample += Math.sin(phase * harmonic) / harmonic
      view.setInt16(44 + (frame * channels + channel) * 2, sample * 3276, true)
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })); urls.push(url); return url
  }
  song.stems = song.stems.filter((stem) => names.includes(stem.type)).map((stem) => ({ ...stem, mediaUrl: tone(names.indexOf(stem.type)) }))
  song.practice = { ...song.practice, masterGainDb: 0, metronomeEnabled: false,
    pitchSemitones: mode.startsWith('pitch-up') ? 12 : mode.startsWith('pitch-down') ? -12 : 0,
    tracks: song.practice.tracks.map((track) => ({ ...track, gainDb: 0, muted: !names.includes(track.stemType), solo: false,
      outputChannelPair: names.includes(track.stemType) ? names.indexOf(track.stemType) * 2 + 1 : 1 })) }
  const devices = await navigator.mediaDevices.enumerateDevices()
  const sink = devices.find((device) => device.kind === 'audiooutput' && device.label.replace(/ \(Virtual\)$/, '') === deviceName)
  if (!sink) throw new Error(`Output missing: ${deviceName}`)
  const engine = new MultiTrackAudioEngine()
  window.testEngine = engine; window.testUrls = urls
  await engine.load(song, sink.deviceId)
  await engine.play()
  if (['reroute', 'solo', 'mute', 'metronome'].includes(mode) || mode.endsWith('-solo')) engine.applyPractice({ ...song.practice,
    metronomeEnabled: mode === 'metronome', metronomeBpm: 240,
    tracks: song.practice.tracks.map((track) => ({ ...track,
      outputChannelPair: mode === 'reroute' ? ({ 1: 7, 7: 1 }[track.outputChannelPair] ?? track.outputChannelPair) : track.outputChannelPair,
      solo: (mode === 'solo' || mode === 'pitch-up-solo') && track.stemType === 'bass'
        || mode === 'pitch-down-solo' && track.stemType === 'guitar',
      muted: mode === 'metronome' || track.muted || (mode === 'mute' && track.stemType === 'drums') })) })
  if (mode === 'device-switch') {
    engine.pause()
    const stereo = devices.find((device) => device.kind === 'audiooutput' && device.label.includes('(Built-in)'))
    if (!stereo) throw new Error('Device-switch test requires a built-in stereo output')
    await engine.setOutputDevice(stereo.deviceId)
    if (engine.availableOutputChannelPairs !== 1) throw new Error('Stereo device retained invalid output pairs')
    await engine.setOutputDevice(sink.deviceId)
    await engine.play()
  }
  return { channels: engine.availableOutputChannelPairs * 2 }
}

function verifyCapture(bytes, capture, mode) {
  if (capture.xruns || capture.frames < capture.sampleRate * 2) throw new Error(`Capture incomplete or dropped audio: ${JSON.stringify(capture)}`)
  const count = capture.sampleRate, samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const tones = frequencies.map((hz, channel) => mode.startsWith('pitch-') && ![2, 3].includes(channel) ? hz * (mode.startsWith('pitch-up') ? 2 : 0.5) : hz)
  let expected = mode === 'mono' ? tones.map((_hz, channel) => tones[channel - channel % 2]) : [...tones]
  if (mode === 'reroute') expected = [...tones.slice(6), ...tones.slice(2, 6), ...tones.slice(0, 2)]
  if (mode === 'solo' || mode.endsWith('-solo')) {
    const active = mode === 'pitch-down-solo' ? [6, 7] : [4, 5]
    expected = expected.map((hz, channel) => active.includes(channel) ? hz : null)
  }
  if (mode === 'mute') expected[2] = expected[3] = null
  const rms = [], isolationDb = []
  for (let channel = 0; channel < 8; channel++) {
    const data = Array.from({ length: count }, (_, frame) => samples[(count + frame) * 8 + channel])
    const level = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / count)
    rms.push(Number(level.toFixed(6)))
    if (mode === 'metronome') {
      if (channel < 2 ? level < 0.001 : level > 0.00001) throw new Error(`Metronome channel ${channel + 1}: ${level}`)
      continue
    }
    if (expected[channel] === null) {
      if (level > 0.00001) throw new Error(`${mode}: muted output ${channel + 1} leaked ${level}`)
      continue
    }
    const windowed = data.map((value, frame) => value * (0.5 - 0.5 * Math.cos(2 * Math.PI * frame / (count - 1))))
    const amplitudeAt = (hz) => {
      const coefficient = 2 * Math.cos(2 * Math.PI * hz / capture.sampleRate)
      let previous = 0, beforePrevious = 0
      for (const value of windowed) { const next = value + coefficient * previous - beforePrevious; beforePrevious = previous; previous = next }
      return 4 * Math.sqrt(Math.max(0, previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious)) / count
    }
    const amplitude = (hz) => {
      let peak = amplitudeAt(hz)
      // Phase-vocoder output is not a mathematically exact oscillator. Search
      // within 12 cents while still requiring separation from all other routes.
      if (mode.startsWith('pitch-')) {
        const radius = hz * (2 ** (12 / 1200) - 1)
        for (let offset = -radius; offset <= radius; offset += 0.5) peak = Math.max(peak, amplitudeAt(hz + offset))
      }
      return peak
    }
    // After soloing a high instrument, formant preservation can suppress its
    // shifted fundamental while retaining its upper harmonics. Accept that
    // instrument's harmonic series in solo tests, and require every other
    // output to be silent. The full-mix pitch cases check the fundamental.
    const signal = mode.endsWith('-solo')
      ? Math.max(...[1, 2, 3, 4].map((harmonic) => amplitude(expected[channel] * harmonic)))
      : amplitude(expected[channel])
    const leakage = Math.max(...tones.filter((hz) => hz !== expected[channel]).map(amplitude))
    const isolation = 20 * Math.log10(signal / Math.max(leakage, 1e-12))
    // Formant/phase processing generates sidebands, which are not evidence of
    // a route leak. Pitch isolation is tested by the solo cases: all six other
    // hardware channels must be silent. Dry sine tests measure spectral leakage.
    if (signal < 0.01 || signal > 0.2 || (!mode.startsWith('pitch-') && isolation < 40)) throw new Error(`${mode}: channel ${channel + 1}, signal=${signal}, isolation=${isolation} dB`)
    if (!mode.startsWith('pitch-')) isolationDb.push(Number(isolation.toFixed(1)))
  }
  if (mode === 'mono' || mode === 'metronome') {
    const channels = mode === 'mono' ? 8 : 2
    for (let ch = 0; ch < channels; ch += 2) if (Math.abs(rms[ch] - rms[ch + 1]) > 0.00001) throw new Error(`${mode}: left/right imbalance`)
  }
  return { rms, isolationDb }
}
