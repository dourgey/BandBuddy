import { describe, expect, it } from 'vitest'
import { buildMixFilter } from '../src/main/export-filter.js'

describe('FFmpeg mix filter', () => {
  it('applies track gain, master gain, A-B, speed and limiter', () => {
    const filter = buildMixFilter({
      tracks: [{ inputIndex: 0, state: { stemType: 'vocals', gainDb: -6, muted: false, solo: false } }],
      masterGainDb: 3,
      playbackRate: 0.8,
      loopStartMs: 1250,
      loopEndMs: 9000
    })
    expect(filter).toContain('atrim=start=1.250:end=9.000')
    expect(filter).toContain('volume=0.50118723')
    expect(filter).toContain('atempo=0.8000')
    expect(filter).toContain('alimiter=limit=0.98:level=disabled')
  })

  it('rejects an inaudible empty mix', () => {
    expect(() => buildMixFilter({ tracks: [], masterGainDb: 0, playbackRate: null, loopStartMs: null, loopEndMs: null })).toThrow('NO_AUDIBLE_TRACKS')
  })

  it('chains pitch-preserving tempo filters for the 0.2x-4x range', () => {
    const filter = buildMixFilter({
      tracks: [{ inputIndex: 0, state: { stemType: 'vocals', gainDb: 0, muted: false, solo: false } }],
      masterGainDb: 0,
      playbackRate: 4,
      loopStartMs: null,
      loopEndMs: null
    })
    expect(filter).toContain('atempo=2.0000,atempo=2.0000')

    const slowFilter = buildMixFilter({
      tracks: [{ inputIndex: 0, state: { stemType: 'vocals', gainDb: 0, muted: false, solo: false } }],
      masterGainDb: 0,
      playbackRate: 0.2,
      loopStartMs: null,
      loopEndMs: null
    })
    expect(slowFilter).toContain('atempo=0.5000,atempo=0.5000,atempo=0.8000')
  })
})
