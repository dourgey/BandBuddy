// Real Electron media decoder + production recording stream + renderer mixer.
// Only the library metadata/input device are fixtures; audio is never mocked.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
if (!process.versions.electron) {
  const { build, createServer } = await import('vite')
  const directory = await mkdtemp(path.join(tmpdir(), 'BandBuddy recording browser-'))
  let server
  try {
    const entry = path.join(directory, 'entry.ts')
    await writeFile(entry, `export { RecordingPlaybackService } from ${JSON.stringify(path.join(root, 'src/main/recording-playback.ts'))};
      export { ArsenalOutputTransport } from ${JSON.stringify(path.join(root, 'src/main/arsenal-output.ts'))};
      export { defaultEffectChain } from ${JSON.stringify(path.join(root, 'packages/shared/src/arsenal.ts'))};
      export { shutdownProcesses } from ${JSON.stringify(path.join(root, 'src/main/process.ts'))};`)
    await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, resolve: { alias: { '@shared': path.join(root, 'packages/shared/src') } },
      build: { ssr: entry, outDir: directory, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'entry.mjs' } } } })
    server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    const electron = (await import('electron')).default
    const env = { ...process.env, RECORDING_BROWSER_ROOT: directory, RECORDING_BROWSER_URL: server.resolvedUrls.local[0] }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 45000)
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) }).finally(() => clearTimeout(timer))
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
} else {
  // Electron cannot emit ready while its main ES module is still evaluating.
  void verify().catch(error => { console.error(error); process.exit(1) })
}

function wave(amplitude) {
  const rate = 48000, frames = rate * 12, bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28)
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
  for (let f = 0; f < frames; f++) bytes.writeFloatLE(amplitude * Math.sin(f * 2 * Math.PI * 440 / rate), 44 + f * 4)
  return bytes
}

async function verify() {
  const { app, BrowserWindow, protocol } = await import('electron')
  const directory = process.env.RECORDING_BROWSER_ROOT
  if (!directory) throw new Error('Run through Node.js')
  app.setPath('userData', path.join(directory, 'profile'))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  protocol.registerSchemesAsPrivileged([{ scheme: 'bandbuddy-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }])
  await app.whenReady()
  console.log('recording playback QA: Electron ready')
  const { RecordingPlaybackService, ArsenalOutputTransport, defaultEffectChain, shutdownProcesses } = await import(pathToFileURL(path.join(directory, 'entry.mjs')).href)
  let forwardedPackets = 0, forwardedPeak = 0
  const transport = new ArsenalOutputTransport(async packet => {
    if (!packet.reset) { forwardedPackets++; for (const sample of packet.samples) forwardedPeak = Math.max(forwardedPeak, Math.abs(sample)) }
    return true
  })
  const outputUrl = transport.open(0)
  const captured = path.join(directory, 'source.wav'), backing = wave(0)
  await writeFile(captured, wave(.1))
  const take = { id: 'take', songId: 'song', recordingTrackId: 'record', playbackRate: 1, pitchSemitones: 0, sampleRate: 48000,
    startPositionMs: 0, alignmentOffsetMs: 0, deviceSnapshot: { compactRecording: true, clockCorrectionRatio: 1 } }
  const song = { durationMs: 1800000, practice: { playbackRate: 1, pitchSemitones: 0, metronomeBpm: 120, metronomeOffsetMs: 0 }, recordingTracks: [] }
  const chain = db => ({ ...defaultEffectChain(), modules: [], outputGainDb: db })
  const service = new RecordingPlaybackService({ resolveLibraryPath: () => captured, audioHostExecutable: () => path.join(root, 'resources/audio-host/win32-x64/bandbuddy-audio-host.exe') },
    { getRecordingTake: () => take, getSong: () => song, getSettings: () => ({ libraryRoot: directory }), getRecordingTakeFile: () => ({ sourceRelPath: 'source.wav' }) },
    {}, { prepare: async chain => ({ chain, modules: [], model: null, ir: null, modelRate: 48000, irRate: 48000 }) }, {})
  const requests = []
  protocol.handle('bandbuddy-media', async request => {
    const url = new URL(request.url)
    if (url.hostname === 'arsenal-output') return transport.response(request)
    if (url.hostname === 'backing') return new Response(backing, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(backing.length), 'Access-Control-Allow-Origin': '*' } })
    requests.push({ range: request.headers.get('range'), tone: url.searchParams.get('db') })
    song.recordingTracks = [{ id: 'record', effects: { enabled: true, chain: chain(Number(url.searchParams.get('db') ?? -6)) } }]
    return service.response(request, 'take', 0)
  })
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  window.webContents.on('console-message', (event) => { if (event.message.includes('recording QA') || event.level === 'error') console.log(event.message) })
  app.on('window-all-closed', () => {})
  let exitCode = 0
  try {
    await window.loadURL(process.env.RECORDING_BROWSER_URL + '?fixtures')
    console.log('recording playback QA: renderer loaded')
    const result = await window.webContents.executeJavaScript(`(async () => {
      const {MultiTrackAudioEngine} = await import('/src/audio-engine.ts');
      const {fixtureDetail,fixtureSongs} = await import('/src/fixtures.ts');
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      // Open the silent device from construction; this avoids opening a real
      // user's output and Chromium's suspended-context sink-switch race.
      const Context = window.AudioContext;
      window.AudioContext = class extends Context {
        constructor(options) { super({...options,sinkId:{type:'none'}}); }
        setSinkId() { return Promise.resolve(); }
      };
      const outputErrors = [];
      window.addEventListener('arsenal-output-error', event => outputErrors.push(event.detail));
      window.bandbuddy = {...window.bandbuddy, arsenal: {
        outputTransport: async () => ${JSON.stringify(outputUrl)}, feed: async () => true,
        onMonitor: () => () => {}, monitorState: async () => ({active:true}), monitor: async () => ({})
      }};
      const song = fixtureDetail(fixtureSongs[0]);
      song.durationMs = 1800000;
      song.practice = {...song.practice,positionMs:0,playbackRate:1,pitchSemitones:0,masterGainDb:0,metronomeEnabled:false,countInBeats:0,loopEnabled:false};
      song.stems = [{...song.stems[0], type:'vocals', mediaUrl:'bandbuddy-media://backing/silent.wav'}];
      const track = {id:'record',songId:song.id,name:'Test recording',gainDb:0,muted:false,solo:true,activeTakeId:'take'};
      const take = {id:'take',songId:song.id,recordingTrackId:track.id,playbackRate:1,pitchSemitones:0,previewMediaUrl:'bandbuddy-media://song/take?db=-6'};
      const engine = new MultiTrackAudioEngine({applySongEq:true});
      engine.onError(error => console.log('recording QA error '+String(error)));
      await engine.load(song); console.log('recording QA engine loaded');
      const analyser = engine.context.createAnalyser(); analyser.fftSize = 4096; engine.master.connect(analyser);
      const rms = () => {const a = new Float32Array(4096); analyser.getFloatTimeDomainData(a); return Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);};
      const sample = async () => {await sleep(150); return rms();};
      let current = {...song,recordingTracks:[track],recordingTakes:[take]};
      const start = performance.now(); await engine.updateRecordingSources(current); const readyMs = performance.now()-start; console.log('recording QA stream ready '+readyMs);
      await engine.play(); while (rms()<.001 && performance.now()-start<3000) await sleep(10);
      const firstSignalMs = performance.now()-start, audible = await sample();
      engine.updateRecordingMix({...current,recordingTracks:[{...track,muted:true}]}); const muted = await sample();
      engine.updateRecordingMix({...current,recordingTracks:[{...track,gainDb:-12}]}); const quieter = await sample();
      engine.updateRecordingMix(current);
      const anchor = engine.tracks.get('vocals').element, before = anchor.currentTime;
      current = {...current,recordingTakes:[{...take,previewMediaUrl:'bandbuddy-media://song/take?db=-12'}]};
      await engine.updateRecordingSources(current); const changedTone = await sample();
      const continuous = !anchor.paused && anchor.currentTime>before;
      engine.seek(5000); const seekSignal = await sample();
      engine.pause(); const pausedAt = anchor.currentTime; await sleep(100); const stable = anchor.currentTime === pausedAt;
      await engine.play(); const resumedSignal = await sample();
      const diagnostics = {context:engine.context.state,time:engine.context.currentTime,sink:engine.context.sinkId,master:engine.master.gain.value,songTracks:engine.song.recordingTracks,
        backing:{ready:anchor.readyState,paused:anchor.paused,time:anchor.currentTime,duration:anchor.duration,error:anchor.error?.message},
        recording:[...engine.recordings.values()].map(r=>({gain:r.gain.gain.value,ready:r.element.readyState,paused:r.element.paused,time:r.element.currentTime,error:r.element.error?.message}))};
      engine.destroy(); return {readyMs,firstSignalMs,audible,muted,quieter,changedTone,continuous,seekSignal,stable,resumedSignal,diagnostics,outputErrors};
    })()`)
    if (result.firstSignalMs > 1000 || result.audible < .02 || result.muted > .0001 || Math.abs(result.quieter / result.audible - .2512) > .04
      || Math.abs(result.changedTone / result.audible - .5012) > .04 || !result.continuous || !result.stable || result.seekSignal < .01 || result.resumedSignal < .01
      || result.outputErrors.length || forwardedPackets < 20 || forwardedPeak < .03) throw new Error(JSON.stringify({ ...result, forwardedPackets, forwardedPeak }))
    const report = { ...result, requests, forwardedPackets, forwardedPeak, boundary: 'Electron silent sink; no physical sound card or listening acceptance' }
    await writeFile(path.join(tmpdir(), 'bandbuddy-recording-browser.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    console.log('PASS: streamed recording is immediately audible, seeks, crossfades tone and obeys mixer/transport controls')
  } catch (error) { console.error(error); exitCode = 1 }
  finally { window.destroy(); await shutdownProcesses(); app.exit(exitCode) }
}
