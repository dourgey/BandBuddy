import { describe, expect, it } from 'vitest'
import { lyricFrameAt, parseLrc } from '@shared/lyrics.js'

describe('LRC lyrics', () => {
  it('parses metadata, offsets, repeated timestamps, translations, and enhanced timestamps', () => {
    const lyrics = parseLrc(`
      [ti:排练示例]
      [ar:BandBuddy]
      [al:练习室]
      [offset:+250]
      [00:01.50][00:03.00]第一句
      [00:03.00]First line
      [00:04.005]<00:04.005>下一句
    `, 'demo.lrc')

    expect(lyrics).toMatchObject({
      fileName: 'demo.lrc',
      title: '排练示例',
      artist: 'BandBuddy',
      album: '练习室'
    })
    expect(lyrics.cues).toEqual([
      { timeMs: 1750, lines: ['第一句'] },
      { timeMs: 3250, lines: ['第一句', 'First line'] },
      { timeMs: 4255, lines: ['下一句'] }
    ])
  })

  it('finds the current and next cue and reports line progress', () => {
    const cues = [
      { timeMs: 1000, lines: ['A'] },
      { timeMs: 3000, lines: ['B'] }
    ]

    expect(lyricFrameAt(cues, 500)).toEqual({ current: null, next: cues[0], progress: 0 })
    expect(lyricFrameAt(cues, 2000)).toEqual({ current: cues[0], next: cues[1], progress: 0.5 })
    expect(lyricFrameAt(cues, 4000)).toEqual({ current: cues[1], next: null, progress: 1 })
  })
})
