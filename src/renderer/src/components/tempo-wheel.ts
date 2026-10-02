/** Convert wheel distance and cadence into bounded, progressively larger steps. */
export function createTempoWheel(): { delta(event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'timeStamp'>): number; reset(): void } {
  let lastTime = -Infinity, lastDirection = 0, speed = 0
  const reset = (): void => { lastTime = -Infinity; lastDirection = 0; speed = 0 }
  return {
    reset,
    delta(event) {
      if (!Number.isFinite(event.deltaY) || !event.deltaY) return 0
      const direction = event.deltaY < 0 ? 1 : -1
      // Pixel, line and page scrolling use different units. About 100 px is one notch.
      const distance = Math.abs(event.deltaY) * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1) / 100
      const elapsed = event.timeStamp - lastTime
      if (direction !== lastDirection || elapsed > 300 || elapsed <= 0) speed = distance * 4
      else speed = speed * 0.5 + distance * 1000 / Math.max(16, elapsed) * 0.5
      lastTime = event.timeStamp
      lastDirection = direction
      const curve = Math.min(1, Math.max(0, (speed - 4) / 26))
      return direction * Math.round(1 + 9 * curve * curve)
    }
  }
}
