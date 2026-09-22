import { describe, expect, it, vi } from 'vitest'
import { JobScheduler } from '../src/main/jobs.js'

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }))

function fixture(): { scheduler: JobScheduler; next: ReturnType<typeof vi.fn>; states: ReturnType<typeof vi.fn> } {
  const job = { id: 'job', songId: 'song', progress: 0.5, type: 'normalizeStems' }
  const next = vi.fn(() => job)
  const states = vi.fn()
  const scheduler = new JobScheduler({} as never, { nextQueuedJob: next, getJob: () => job, setJobState: states } as never,
    { onChange: () => {} } as never, {} as never, { error: vi.fn() } as never, vi.fn(), vi.fn())
  return { scheduler, next, states }
}

describe('scheduler shutdown', () => {
  it('does not reload tasks for unrelated environment download progress', () => {
    let runtimeChanged!: (value: { status: string }) => void
    const changed = vi.fn()
    new JobScheduler({} as never, {} as never,
      { onChange: (callback: typeof runtimeChanged) => { runtimeChanged = callback } } as never,
      {} as never, { error: vi.fn() } as never, changed, vi.fn())
    runtimeChanged({ status: 'downloadingModel' })
    runtimeChanged({ status: 'installingDependencies' })
    expect(changed).not.toHaveBeenCalled()
  })
  it('does not launch queued work when exit starts before its microtask', async () => {
    const { scheduler, next } = fixture()
    scheduler.kick()
    await scheduler.shutdown()
    scheduler.kick()
    await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
  })

  it('waits for active cancellation and keeps the interrupted status without starting the next job', async () => {
    const { scheduler, next, states } = fixture()
    let closed = false
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(scheduler as unknown as { runJob(job: unknown, signal: AbortSignal): Promise<void> }, 'runJob').mockImplementation(async (_job, signal) => {
      started()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
        setTimeout(() => { closed = true; reject(new Error('cancelled')) }, 20)
      }, { once: true }))
    })
    scheduler.kick()
    await ready
    await scheduler.shutdown()
    expect(closed).toBe(true)
    expect(next).toHaveBeenCalledTimes(1)
    expect(states.mock.calls.map(call => call[1])).toEqual(['interrupted'])
  })
})
