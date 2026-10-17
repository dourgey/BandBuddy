import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticError, errorEvidence, redactDiagnostics } from '../src/main/diagnostic-errors.js'
import { DiagnosticStore } from '../src/main/diagnostics.js'
import { environmentIssue } from '../src/main/environment-issues.js'
import { classifyJobError as classifyError } from '../src/main/job-state.js'

const roots: string[] = [], stores: DiagnosticStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.flush())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'bb-diagnostics-')); roots.push(root); const store = new DiagnosticStore(); stores.push(store); store.initialize(root, 'test'); return { root, store } }

describe('diagnostic fault matrix', () => {
  it.each([
    ['STALE_VOCAL_SPLIT', 'STALE_VOCAL_SPLIT', 'retry'],
    ['VOCAL_MODEL_HASH_MISMATCH', 'VOCAL_MODEL_HASH_MISMATCH', 'retry'], ['VOCAL_CONFIG_HASH_MISMATCH', 'VOCAL_CONFIG_HASH_MISMATCH', 'repairApplication'],
    ['VOCAL_ENCODED_FRAME_MISMATCH', 'VOCAL_ENCODED_FRAME_MISMATCH', 'retry'],
    ['DOWNLOAD_HTTP_404', 'DOWNLOAD_SOURCE_MISSING', 'network'], ['DOWNLOAD_HTTP_407', 'PROXY_AUTH_REQUIRED', 'network'],
    ['DOWNLOAD_HTTP_403', 'DOWNLOAD_ACCESS_DENIED', 'network'], ['DOWNLOAD_HTTP_429', 'DOWNLOAD_RATE_LIMITED', 'retry'],
    ['DOWNLOAD_HTTP_503', 'NETWORK_UNAVAILABLE', 'network'], ['ENOTFOUND', 'NETWORK_UNAVAILABLE', 'network'],
    ['DOWNLOAD_IDLE_TIMEOUT', 'NETWORK_UNAVAILABLE', 'network'], ['CERT_DATE_INVALID', 'CERTIFICATE_TIME_INVALID', 'time'],
    ['CERT_AUTHORITY_INVALID', 'TRUST_CHECK_FAILED', 'security'], ['ENOSPC', 'DISK_FULL', 'storage'],
    ['EROFS', 'STORAGE_UNAVAILABLE', 'storage'], ['VC_RUNTIME_PROBE_FAILED', 'SYSTEM_PROBE_FAILED', 'security'],
    ['VC_RUNTIME_ELEVATION_CANCELLED', 'AUTHORIZATION_REQUIRED', 'retry'], ['VC_RUNTIME_RESTART_REQUIRED', 'RESTART_REQUIRED', 'restart'],
    ['VC_RUNTIME_INSTALL_BUSY', 'SYSTEM_INSTALL_PENDING', 'retry'], ['VC_RUNTIME_SIGNATURE_INVALID', 'SIGNATURE_INVALID', 'repairApplication'],
    ['CPU_OUT_OF_MEMORY', 'CPU_OUT_OF_MEMORY', 'retry'], ['CUDA_OOM', 'ACCELERATOR_OOM', 'retry'],
    ['DEPENDENCIES_INCOMPLETE', 'RUNTIME_COMPONENT_FAILED', 'repair'], ['AUDIO_DECODE_FAILED', 'SOURCE_MEDIA_INVALID', 'retry'],
    ['MICROPHONE_PERMISSION_DENIED', 'MICROPHONE_PERMISSION', 'microphone'], ['SELECTED_SAMPLE_RATE_UNAVAILABLE', 'AUDIO_CONFIGURATION_INVALID', 'audio'],
    ['DRIVER_PROBLEM', 'ACCELERATION_UNAVAILABLE', 'driver'], ['UNSUPPORTED_ARCH', 'UNSUPPORTED_SYSTEM', 'repairApplication'],
    ['SQLITE_CORRUPT', 'DATABASE_UNAVAILABLE', 'storage'], ['PROCESS_TIMEOUT', 'PROCESS_TIMEOUT', 'retry']
  ])('retains %s evidence and gives a concrete action', (original, code, action) => {
    const issue = environmentIssue(new DiagnosticError(original, 'original failure', { stage: 'real-stage', exitCode: 9 }))
    expect(issue).toMatchObject({ code, action, stage: 'real-stage', evidence: { code: original, details: { exitCode: 9 } } })
    expect(issue.nextSteps?.length).toBeGreaterThan(0)
    expect(issue.diagnosticId).toMatch(/^[\da-f-]{36}$/)
  })
  it('does not infer broken hardware from an access violation', () => {
    expect(environmentIssue(new DiagnosticError('NATIVE_CRASH', 'worker exit', { exitCode: 3221225477 })).confidence).toBe('unknown')
  })
  it('preserves nested causes, plain RPC evidence and native Error codes', () => {
    const error = new DiagnosticError('WORKER_FAILED', 'import', {}, Object.assign(new Error('DLL load failed'), { code: 'DLL_MISSING', errno: 126 }))
    expect(errorEvidence(errorEvidence(error))).toMatchObject({ causes: [{ code: 'DLL_MISSING', details: { errno: 126 } }] })
    expect(classifyError(new DiagnosticError('CPU_OUT_OF_MEMORY', 'allocation failed', {}, 'CUDA_OOM')).code).toBe('CPU_OUT_OF_MEMORY')
    expect(classifyError(new Error('MODEL_HASH_MISMATCH:model')).code).toBe('MODEL_HASH_MISMATCH')
  })
  it('redacts credentials, URLs, private paths and nested errors in one format', () => {
    const text = redactDiagnostics({ error: new DiagnosticError('REQUEST_FAILED', 'https://name:pass@proxy.example/private?token=abc', { proxyUrl: 'http://pass', source: 'D:\\Private\\Audio\\take.wav', token: 'abc' }) })
    expect(text).not.toMatch(/pass|abc|Private|take.wav/)
    expect(JSON.parse(text).error.code).toBe('REQUEST_FAILED')
  })
  it('associates process, download and recovery events with the same problem across restart', async () => {
    const { store, root } = await fixture()
    const id = '10000000-0000-4000-8000-000000000001'
    store.withScope({ diagnosticId: id, jobId: 'job-1' }, () => {
      store.record({ component: 'network', stage: 'download', result: 'HTTP_404' })
      store.report(new Error('DOWNLOAD_HTTP_404'), 'separation')
      store.attempted(id, '切换可信来源', '失败')
    })
    await store.flush()
    const restored = new DiagnosticStore(); stores.push(restored); restored.initialize(root, 'test'); await restored.flush()
    const report = restored.snapshot({ jobId: 'job-1' })
    expect(report.issues).toHaveLength(1)
    expect(report.events).toHaveLength(3)
    expect(report.summary).toContain('切换可信来源')
  })
  it('caps journal size and retains a copyable in-memory summary when writing fails', async () => {
    const { store, root } = await fixture()
    for (let index = 0; index < 620; index++) store.record({ component: 'compute', stage: String(index), result: 'failed', details: 'x'.repeat(6000) })
    await store.flush()
    expect((await readFile(path.join(root, 'environment-diagnostics.json'))).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
    const fileRoot = path.join(root, 'not-a-directory'); await writeFile(fileRoot, 'file')
    const broken = new DiagnosticStore(); stores.push(broken); broken.initialize(fileRoot, 'test'); broken.report('CPU_OUT_OF_MEMORY', 'separation'); await broken.flush()
    expect(broken.snapshot().persistenceError).not.toBeNull()
    expect(broken.snapshot().summary).toContain('系统内存不足')
  })
})
