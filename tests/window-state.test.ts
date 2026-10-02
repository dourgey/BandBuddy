import { describe, expect, it } from 'vitest'
import { normalizeWindowSize, WindowState } from '../src/main/window-state.js'

const limits = { width: 1180, height: 760 }
const fallback = { width: 1440, height: 960, maximized: false }

describe('window state', () => {
  it('rejects stored values that are not a usable size', () => {
    for (const raw of [null, undefined, 'wide', 42, [], {}, { width: 1200 }, { width: 'x', height: 800 }]) {
      expect(normalizeWindowSize(raw, limits)).toBeNull()
    }
    expect(normalizeWindowSize({ width: Number.NaN, height: 800 }, limits)).toBeNull()
    expect(normalizeWindowSize({ width: Infinity, height: 800 }, limits)).toBeNull()
  })

  it('clamps to the minimum so an old or hand-edited file cannot shrink the window', () => {
    expect(normalizeWindowSize({ width: 400, height: 300 }, limits))
      .toEqual({ width: 1180, height: 760, maximized: false })
  })

  it('rounds fractional sizes and honours maximized only when strictly true', () => {
    expect(normalizeWindowSize({ width: 1600.6, height: 900.4, maximized: true }, limits))
      .toEqual({ width: 1601, height: 900, maximized: true })
    expect(normalizeWindowSize({ width: 1600, height: 900, maximized: 'yes' }, limits)?.maximized).toBe(false)
  })

  it('falls back to the default size when nothing usable is stored', () => {
    expect(new WindowState('/nonexistent-dir/window-state.json', limits).restore(fallback)).toEqual(fallback)
  })

  it('fits a saved large-monitor window inside a smaller work area', () => {
    expect(normalizeWindowSize({ width: 2560, height: 1600 }, limits, { width: 1366, height: 728 }))
      .toEqual({ width: 1366, height: 728, maximized: false })
    expect(new WindowState('/nonexistent-dir/window-state.json', limits, { width: 1024, height: 700 }).restore(fallback))
      .toEqual({ width: 1024, height: 700, maximized: false })
  })
})
