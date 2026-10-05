import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobScheduler } from '../src/main/jobs.js'
vi.mock('electron', () => ({ Notification: class {}, session: {} }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(repaired = true, repairedDevice = 'cpu', failureCode = 3221225781) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bb-job-env-')); roots.push(root)
  let device = 'cuda'
  const runWorker = vi.fn().mockResolvedValueOnce({ code: failureCode, error: `PROCESS_EXIT:${failureCode}`, result: {} }).mockResolvedValue({ code: 0, error: null, result: { files: {} } })
  const recoverWorker = vi.fn(async () => { device = repairedDevice; return repaired })
  const database = { setJobState: vi.fn(), updateJobPayload: vi.fn() }
  const scheduler = new JobScheduler({} as never, database as never, { onChange: vi.fn(), getInfo: () => ({ selectedDevice: device }), runWorker, recoverWorker } as never, {} as never, {} as never, vi.fn(), vi.fn())
  const run = (retries = 0) => (scheduler as unknown as { runStemWorker(...args: unknown[]): Promise<unknown> }).runStemWorker('job', { sourceRelPath: 'input.wav', guitarQuality: 'high', environmentRepairs: retries }, 'separate-guitar', 'input.wav', path.join(root, 'worker'), 'models', .1, '正在分轨', new AbortController().signal)
  return { run, runWorker, recoverWorker, database }
}
describe('task-preserving environment recovery', () => {
  it.each([3221225781, 3221225477])('recovers native process failure %s in an independent CPU environment without changing quality or task', async failureCode => {
    const f = await setup(true, 'cpu', failureCode); await f.run()
    expect(f.recoverWorker).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.runWorker).toHaveBeenCalledTimes(2)
    expect(f.runWorker.mock.calls[1]![0]).toEqual(['separate-guitar', '--input', 'input.wav', '--output', expect.any(String), '--model-root', 'models', '--device', 'cpu', '--quality', 'high'])
    expect(f.database.updateJobPayload).toHaveBeenCalledWith('job', expect.objectContaining({ environmentRepairs: 1, guitarQuality: 'high' }))
  })
  it('keeps the task waiting when preparation needs user action, without another inference', async () => {
    const f = await setup(false); await expect(f.run()).rejects.toThrow('RUNTIME_RECOVERY_PENDING'); expect(f.runWorker).toHaveBeenCalledOnce()
  })
  it('does not repeatedly rebuild for a task that has exhausted automatic recovery', async () => {
    const f = await setup(); await expect(f.run(1)).rejects.toThrow(); expect(f.recoverWorker).not.toHaveBeenCalled()
  })
  it('retains the used repair attempt when later falling back for GPU memory', async () => {
    const f = await setup(true, 'cuda')
    f.runWorker.mockReset()
      .mockImplementationOnce(async (_args, _signal, _timeout, message) => { message({ type: 'error', code: 'MODEL_HASH_MISMATCH' }); return { code: 1, error: 'MODEL_HASH_MISMATCH', result: {} } })
      .mockImplementationOnce(async (_args, _signal, _timeout, message) => { message({ type: 'error', code: 'CUDA_OOM' }); return { code: 1, error: 'CUDA_OOM', result: {} } })
      .mockResolvedValue({ code: 0, error: null, result: {} })
    await f.run()
    expect(f.runWorker).toHaveBeenCalledTimes(3)
    expect(f.database.updateJobPayload).toHaveBeenLastCalledWith('job', expect.objectContaining({ environmentRepairs: 1, deviceOverride: 'cpu', guitarQuality: 'high' }))
  })
})
