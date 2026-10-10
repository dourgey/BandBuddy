import type { PracticeState } from '@shared/domain.js'

export type PracticeSaveStatus = 'saved' | 'saving' | 'error'
interface PendingSave { snapshot: PracticeState; revision: number }

/** All practice writes share a serial queue, and every pending snapshot owns its song ID. */
export class PracticePersistence {
  private pending = new Map<string, PendingSave>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private revisions = new Map<string, number>()
  private statuses = new Map<string, PracticeSaveStatus>()
  private listeners = new Set<() => void>()
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly write: (snapshot: PracticeState) => Promise<void>) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getStatus = (songId: string): PracticeSaveStatus => this.statuses.get(songId) ?? 'saved'

  private status(songId: string, status: PracticeSaveStatus): void {
    if (this.getStatus(songId) === status) return
    this.statuses.set(songId, status)
    for (const listener of this.listeners) listener()
  }

  schedule(snapshot: PracticeState, delay = 500): void {
    const songId = snapshot.songId
    const revision = (this.revisions.get(songId) ?? 0) + 1
    this.revisions.set(songId, revision)
    this.pending.set(songId, { snapshot: structuredClone(snapshot), revision })
    this.status(songId, 'saving')
    clearTimeout(this.timers.get(songId))
    this.timers.set(songId, setTimeout(() => { void this.flush(songId).catch(() => undefined) }, delay))
  }

  flush(songId: string): Promise<void> {
    clearTimeout(this.timers.get(songId)); this.timers.delete(songId)
    if (this.pending.has(songId)) this.status(songId, 'saving')
    const task = this.chain.catch(() => undefined).then(async () => {
      const pending = this.pending.get(songId)
      if (!pending) return
      try {
        await this.write(pending.snapshot)
        if (this.pending.get(songId)?.revision === pending.revision) {
          this.pending.delete(songId)
          this.status(songId, 'saved')
        }
      } catch (error) {
        this.status(songId, 'error')
        throw error
      }
    })
    this.chain = task
    return task
  }

  async flushAll(): Promise<void> { for (const songId of this.pending.keys()) await this.flush(songId) }
}
