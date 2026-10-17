import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentManager, environmentIssue, redactDiagnostics } from '../src/main/environment.js'
import { StartupRecovery } from '../src/main/startup-recovery.js'
import type { RuntimeInfo } from '../packages/shared/src/domain.js'
import { DiagnosticStore } from '../src/main/diagnostics.js'

const roots: string[] = [], managers: EnvironmentManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.shutdown())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(root?: string, safe = false, inspectAudio?: () => Promise<{ checks: []; issues: [] }>) {
  root ??= await mkdtemp(path.join(os.tmpdir(), 'bb-env-')); if (!roots.includes(root)) roots.push(root)
  let info = { status: 'missing', selectedDevice: 'cpu' } as RuntimeInfo
  const runtime = { onChange: vi.fn(() => () => {}), networkReachable: vi.fn(async () => true), setPreparationGate: vi.fn(), setFaultRecovery: vi.fn(), detect: vi.fn(async () => info), getInfo: () => info, repair: vi.fn(async () => { info = { ...info, status: 'ready' }; return info }), verifyNativePrerequisites: vi.fn(async (_signal?: AbortSignal, _repair?: boolean) => {}), cancelInstall: vi.fn(), downloadDiagnostics: () => [] }
  const media = { ready: vi.fn(async () => {}), toolsReady: vi.fn(async () => true), repair: vi.fn(async () => {}), downloadDiagnostics: () => [] }
  let busy = false
  const diagnostics = new DiagnosticStore(); diagnostics.initialize(root, '3')
  const manager = new EnvironmentManager({ localRoot: root, dataRoot: root } as never, runtime as never, media as never, { warn: vi.fn(), flush: async () => {} } as never, '3', () => busy, safe, false, { diagnostics, inspectAudio })
  managers.push(manager)
  return { manager, runtime, media, root, busy(value: boolean) { busy = value } }
}
describe('environment preparation and recovery', () => {
  it('keeps a failed stream blocked until a user initiated stream actually opens', async () => {
    const f = await fixture(undefined, false, async () => ({ checks: [], issues: [] }))
    await f.manager.resume()
    f.manager.reportAudioFailure('DEVICE_DISCONNECTED')
    await f.manager.check()
    expect(f.manager.get().capabilities.recording).toBe('unavailable')
    expect(f.manager.get().checks).toContainEqual(expect.objectContaining({ id: 'audio-stream', status: 'failed' }))
    f.manager.reportAudioSuccess('48000 Hz')
    expect(f.manager.get().capabilities.recording).toBe('ready')
    expect(f.manager.get().issues).toHaveLength(0)
  })
  it('rechecks only the requested media issue and clears it after successful verification', async () => {
    const f = await fixture(); f.media.toolsReady.mockResolvedValue(false); f.media.repair.mockRejectedValue(new Error('DOWNLOAD_HTTP_404'))
    await f.manager.prepare()
    const issue = f.manager.get().issues.find(item => item.capability === 'media')!
    f.runtime.detect.mockClear(); f.runtime.verifyNativePrerequisites.mockClear(); f.media.toolsReady.mockResolvedValue(true)
    await f.manager.check(issue.diagnosticId)
    expect(f.runtime.detect).not.toHaveBeenCalled(); expect(f.runtime.verifyNativePrerequisites).not.toHaveBeenCalled()
    expect(f.manager.get().issues).toHaveLength(0)
    expect(f.manager.get().capabilities.separation).toBe('ready')
  })
  it('does not reset retries on duplicate online events without a reachability transition', async () => {
    const f = await fixture(); f.runtime.repair.mockRejectedValue(new Error('ENOTFOUND')); f.runtime.networkReachable.mockResolvedValue(false)
    await f.manager.prepare(); await f.manager.networkRestored()
    expect(f.runtime.repair).toHaveBeenCalledTimes(1)
    f.runtime.networkReachable.mockResolvedValue(true)
    await f.manager.networkRestored(); await f.manager.networkRestored()
    expect(f.runtime.repair).toHaveBeenCalledTimes(2)
    f.runtime.networkReachable.mockResolvedValue(false); await f.manager.networkRestored()
    f.runtime.networkReachable.mockResolvedValue(true); await f.manager.networkRestored()
    expect(f.runtime.repair).toHaveBeenCalledTimes(3)
  })
  it('migrates legacy paused state, tolerates invalid state and uses a fresh cancellation signal after resume', async () => {
    const f = await fixture(); await f.manager.shutdown()
    await writeFile(path.join(f.root, 'environment-state.json'), JSON.stringify({ schema: 1, version: '3', paused: true, attempts: [], issues: [] }))
    const restarted = await fixture(f.root); await restarted.manager.startAutomatically()
    expect(restarted.manager.get().phase).toBe('paused')
    await restarted.manager.resume(); expect(restarted.manager.get().phase).toBe('ready')
    await restarted.manager.pause(); await restarted.manager.resume()
    expect(restarted.manager.get().phase).toBe('ready')
    await restarted.manager.shutdown()
    await writeFile(path.join(f.root, 'environment-state.json'), 'invalid')
    const recovered = await fixture(f.root); await recovered.manager.resume()
    expect(recovered.manager.get().phase).toBe('ready')
    expect(recovered.manager.diagnosticReport().events.some(event => event.stage === 'load-environment-state')).toBe(true)
  })
  it('does not automatically reinstall for CPU memory exhaustion or unknown system probes', async () => {
    const f = await fixture()
    f.runtime.detect.mockImplementation(async () => ({ ...f.runtime.getInfo(), status: 'failed', error: 'CPU_OUT_OF_MEMORY' }))
    f.runtime.verifyNativePrerequisites.mockRejectedValue(new Error('VC_RUNTIME_PROBE_FAILED'))
    await f.manager.prepare(); await f.manager.prepare()
    expect(f.runtime.repair).not.toHaveBeenCalled()
    expect(f.runtime.verifyNativePrerequisites.mock.calls.every(call => call[1] === false)).toBe(true)
    expect(f.manager.get().issues[0]?.code).toBe('SYSTEM_PROBE_FAILED')
  })
  it('finishes a read-only check without leaving an absent environment stuck preparing', async () => {
    const f = await fixture()
    expect((await f.manager.check()).phase).toBe('needsAction')
    expect(f.runtime.repair).not.toHaveBeenCalled()
    await f.manager.resume()
    expect(f.manager.get().phase).toBe('ready')
  })
  it('coalesces preparation calls and retains independent capabilities after a failure', async () => {
    const { manager, runtime, media } = await fixture()
    media.toolsReady.mockResolvedValue(false); media.repair.mockRejectedValue(new Error('DOWNLOAD_HTTP_404'))
    await Promise.all([manager.startAutomatically(), manager.startAutomatically()])
    expect(media.repair).toHaveBeenCalledOnce(); expect(runtime.repair).toHaveBeenCalledOnce()
    expect(manager.get()).toMatchObject({ phase: 'needsAction', capabilities: { media: 'unavailable', separation: 'unavailable', recording: 'ready' } })
    expect(manager.get().checks).toContainEqual(expect.objectContaining({ id: 'separation-media', status: 'blocked' }))
    expect(manager.get().issues[0]?.code).toBe('DOWNLOAD_SOURCE_MISSING')
  })
  it('persists an explicit pause across restart, and only explicit resume clears it', async () => {
    const first = await fixture(); await first.manager.pause(); await first.manager.shutdown()
    const second = await fixture(first.root); await second.manager.startAutomatically(); await second.manager.networkRestored()
    expect(second.runtime.detect).not.toHaveBeenCalled(); expect(second.manager.get().pausedByUser).toBe(true)
    await second.manager.resume(); expect(second.runtime.repair).toHaveBeenCalledOnce()
  })
  it('does not repeat a rejected authorization on restart or network restoration', async () => {
    const first = await fixture(); first.runtime.verifyNativePrerequisites.mockRejectedValue(new Error('VC_RUNTIME_ELEVATION_CANCELLED'))
    await first.manager.startAutomatically(); expect(first.runtime.repair).not.toHaveBeenCalled()
    await first.manager.shutdown()
    const second = await fixture(first.root)
    let installed = false
    second.runtime.verifyNativePrerequisites.mockImplementation(async (_signal, repair) => { if (repair) installed = true; if (!installed) throw new Error('VC_RUNTIME_MISSING') })
    await second.manager.startAutomatically(); await second.manager.networkRestored()
    expect(second.runtime.verifyNativePrerequisites.mock.calls.every(call => call[1] === false)).toBe(true)
    expect(second.manager.get().issues.some(issue => issue.code === 'AUTHORIZATION_REQUIRED')).toBe(true)
    await second.manager.resume()
    expect(second.runtime.verifyNativePrerequisites.mock.calls.filter(call => call[1] === true)).toHaveLength(1)
  })
  it('bounds automatic repair across process restarts but permits a network recovery round', async () => {
    const first = await fixture(); first.runtime.repair.mockRejectedValue(new Error('DOWNLOAD_CONNECT_TIMEOUT'))
    await first.manager.startAutomatically(); await first.manager.startAutomatically(); expect(first.runtime.repair).toHaveBeenCalledOnce()
    const second = await fixture(first.root); await second.manager.startAutomatically(); expect(second.runtime.repair).not.toHaveBeenCalled()
    await second.manager.networkRestored(); expect(second.runtime.repair).toHaveBeenCalledOnce()
    expect(second.manager.get().phase).toBe('ready')
  })
  it('defers heavy checks until recording or monitoring ends', async () => {
    const f = await fixture(); f.busy(true)
    const work = f.manager.startAutomatically()
    await vi.waitFor(() => expect(f.manager.get().phase).toBe('waitingIdle'))
    expect(f.media.ready).not.toHaveBeenCalled(); expect(f.runtime.detect).not.toHaveBeenCalled()
    f.busy(false); await work; expect(f.manager.get().phase).toBe('ready')
  })
  it('retries a changed network policy without repeating a rejected system authorization', async () => {
    const f = await fixture()
    f.media.toolsReady.mockResolvedValueOnce(false); f.media.repair.mockRejectedValue(new Error('DOWNLOAD_CONNECT_TIMEOUT'))
    f.runtime.verifyNativePrerequisites.mockRejectedValue(new Error('VC_RUNTIME_ELEVATION_CANCELLED'))
    await f.manager.startAutomatically()
    await f.manager.configurationChanged(false)
    expect(f.manager.get().capabilities.media).toBe('ready')
    expect(f.runtime.verifyNativePrerequisites.mock.calls.every(call => call[1] === false)).toBe(true)
    expect(f.runtime.repair).not.toHaveBeenCalled()
  })
  it('safe startup remains idle until an explicit resume', async () => {
    const f = await fixture(undefined, true); await f.manager.startAutomatically()
    expect(f.runtime.detect).not.toHaveBeenCalled(); expect(f.manager.get().phase).toBe('paused')
    await f.manager.resume(); expect(f.manager.get().phase).toBe('ready')
  })
  it('exports local diagnostics without proxy credentials or private paths', async () => {
    const f = await fixture(); await f.manager.startAutomatically()
    const file = path.join(f.root, 'report.json'); await f.manager.exportDiagnostics(file)
    expect(JSON.parse(await readFile(file, 'utf8')).applicationVersion).toBe('3')
    const redacted = redactDiagnostics({ endpoint: 'https://alice:password@proxy.example:8080/a?token=secret', token: 'secret', file: f.root + '/audio.wav' }, [f.root])
    expect(redacted).not.toContain('password'); expect(redacted).not.toContain('secret'); expect(redacted).not.toContain(f.root.replaceAll('\\', '\\\\'))
    expect(() => JSON.parse(redacted)).not.toThrow()
  })
  it.each([['ENOSPC', 'storage'], ['CERT_DATE_INVALID', 'time'], ['UNSUPPORTED_SYSTEM', 'repairApplication'], ['MICROPHONE_PERMISSION_DENIED', 'microphone'], ['VC_RUNTIME_RESTART_REQUIRED', 'restart']])('maps %s to a concrete action', (error, action) => expect(environmentIssue(error).action).toBe(action))
  it('recovers repeated startup failures without a database and clears only after the UI is interactive', async () => {
    const f = await fixture(); new StartupRecovery(f.root).begin(); new StartupRecovery(f.root).begin()
    const third = new StartupRecovery(f.root); expect(third.safeMode).toBe(true)
    third.begin(); third.success(); expect(new StartupRecovery(f.root).safeMode).toBe(false)
    third.fail(); expect(new StartupRecovery(f.root).safeMode).toBe(true)
    third.clear(); expect(new StartupRecovery(f.root).safeMode).toBe(false)
  })
})
