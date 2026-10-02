/** Local fixture diagnostics only; excluded from production by the caller. */
export function observeFixtureInteractions(): void {
  const output = document.createElement('output')
  output.id = 'bandbuddy-interaction-metrics'
  output.hidden = true
  output.dataset.minimumDurationMs = '16'
  output.dataset.status = 'unsupported'
  document.body.append(output)
  if (!PerformanceObserver.supportedEntryTypes.includes('event')) return
  const samples = new Map<number, { duration: number; event: string }>()
  output.dataset.status = 'observing'
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      if (!entry.interactionId) continue
      const previous = samples.get(entry.interactionId)
      if (!previous || entry.duration > previous.duration) samples.set(entry.interactionId, { duration: entry.duration, event: entry.name })
      if (samples.size > 200) samples.delete(samples.keys().next().value!)
    }
    const durations = [...samples.values()].map(entry => entry.duration).sort((a, b) => a - b)
    output.dataset.count = String(durations.length)
    output.dataset.p95Ms = String(durations[Math.max(0, Math.ceil(durations.length * .95) - 1)] ?? 0)
    output.dataset.maxMs = String(durations.at(-1) ?? 0)
    output.dataset.samples = JSON.stringify([...samples.values()])
  })
  const options: PerformanceObserverInit & { durationThreshold: number } = { type: 'event', buffered: true, durationThreshold: 16 }
  observer.observe(options)
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
}
