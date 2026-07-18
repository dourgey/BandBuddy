import { describe, expect, it } from 'vitest'
import { mediaResponseHeaders, parseByteRange } from '../src/main/media-range.js'

describe('bandbuddy-media HTTP ranges', () => {
  it('supports bounded, open-ended and suffix byte ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('rejects traversal-like, multi-range and out-of-bounds values', () => {
    expect(parseByteRange('bytes=100-101', 100)).toBeNull()
    expect(parseByteRange('bytes=1-2,4-5', 100)).toBeNull()
    expect(parseByteRange('bytes=-0', 100)).toBeNull()
  })

  it('allows waveform fetches and Web Audio media nodes to read protected assets', () => {
    expect(mediaResponseHeaders('audio/flac', 2048)).toMatchObject({
      'Content-Type': 'audio/flac',
      'Content-Length': '2048',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    })
  })
})
