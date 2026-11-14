import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { JobScheduler } from '../src/main/jobs.js'

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }))

describe('stem worker accelerator fallback', () => {
  it.each(['fast', 'balanced', 'high'] as const)('retries %s on CPU with the same source, model and quality', async guitarQuality => {
    const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'bandbuddy-fallback-'))
    const partial = path.join(workerRoot, 'partial.wav')
    writeFileSync(partial, 'incomplete GPU output')
    const updateJobPayload = vi.fn()
    const result = { code: 0, result: { files: {} }, error: null }
    const runWorker = vi.fn()
      .mockImplementationOnce(async (_args, _signal, _timeout, onMessage) => {
        onMessage({ type: 'error', code: 'ACCELERATOR_OOM' })
        return { code: 1, result: {}, error: 'MPS out of memory' }
      })
      .mockImplementationOnce(async () => {
        expect(existsSync(workerRoot)).toBe(true)
        expect(existsSync(partial)).toBe(false)
        return result
      })
    const scheduler = new JobScheduler({} as never,
      { setJobState: vi.fn(), updateJobPayload } as never,
      { onChange: vi.fn(), getInfo: () => ({ selectedDevice: 'mps' }), recoverWorker: vi.fn().mockResolvedValue(true), runWorker } as never,
      {} as never, {} as never, vi.fn(), vi.fn())
    const payload = { sourceRelPath: 'source.wav', guitarQuality, retry: 0 }
    const signal = new AbortController().signal
    try {
      const completed = await (scheduler as unknown as {
        runStemWorker(...args: unknown[]): Promise<unknown>
      }).runStemWorker('job', payload, 'separate-guitar', '/source.wav', workerRoot, '/models', 0.1, '正在分离吉他', signal)
      expect(completed).toEqual({ result, selected: 'cpu' })
      expect(runWorker).toHaveBeenCalledTimes(2)
      for (const [index, device] of ['mps', 'cpu'].entries()) {
        expect(runWorker.mock.calls[index]?.slice(0, 3)).toEqual([
          ['separate-guitar', '--input', '/source.wav', '--output', workerRoot, '--model-root', '/models', '--device', device, '--quality', guitarQuality],
          signal, 0
        ])
      }
      expect(updateJobPayload).toHaveBeenCalledWith('job', { ...payload, deviceOverride: 'cpu', retry: 1 })
    } finally {
      await rm(workerRoot, { recursive: true, force: true })
    }
  })
})
