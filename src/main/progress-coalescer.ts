/** Coalesces repeated progress updates; state transitions are published at once. */
export class ProgressCoalescer<T> {
  private pending: T | null = null
  private timer: NodeJS.Timeout | null = null
  private key: string | null = null
  private lastPublishedAt = -Infinity

  constructor(private readonly publish: (value: T) => void, private readonly intervalMs = 150) {}

  push(value: T, key: string): void {
    if (key !== this.key) this.cancel()
    this.key = key
    this.pending = value
    const delay = this.intervalMs - (Date.now() - this.lastPublishedAt)
    if (delay <= 0) this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), delay)
      this.timer.unref()
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const value = this.pending
    this.pending = null
    if (value === null) return
    this.lastPublishedAt = Date.now()
    this.publish(value)
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    this.key = null
    this.lastPublishedAt = -Infinity
  }
}
