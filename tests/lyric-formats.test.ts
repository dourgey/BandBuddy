import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { encryptQrc } from 'qrc-decoder'
import { parseLyrics, lyricFrameAt, lyricWordFrame } from '@shared/lyrics.js'
import { decodeLyricFile } from '../src/main/lyric-files.js'

describe('lyric import and timed display', () => {
  it('keeps translations alongside timed words and accepts bracket-style word markers', () => {
    const doc = parseLyrics('[00:01.00]你[00:01.50]好[00:02.00]\n[00:01.00]Hello\n[00:03.00]下一句', 'word.lrc')
    expect(doc.cues[0]!.wordLines).toEqual([
      [{ text: '你', timeMs: 1000, endMs: 1500 }, { text: '好', timeMs: 1500, endMs: 2000 }],
      [{ text: 'Hello', timeMs: 1000, endMs: 3000 }]
    ])
  })
  it('retains enhanced LRC word timing, offsets and repeated lines', () => {
    const doc = parseLyrics('[offset:100]\n[00:01.00][00:05.00]<00:01.00>你<00:01.50>好<00:02.00>', 'word.lrc')
    expect(doc.cues.map(c => c.lines)).toEqual([['你好'], ['你好']])
    expect(doc.cues[1]!.wordLines?.[0]).toEqual([{ text: '你', timeMs: 5100, endMs: 5600 }, { text: '好', timeMs: 5600, endMs: 6100 }])
    expect(lyricWordFrame(doc.cues[0]!, 1350)).toEqual([[{ text: '你', progress: 0.5 }, { text: '好', progress: 0 }]])
  })
  it('decodes compressed KRC and preserves word durations across reopening', () => {
    const source = '[1000,2000]<0,500,0>你<500,1500,0>好'
    const key = Buffer.from([64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105])
    const payload = deflateSync(Buffer.from(source))
    const encoded = Buffer.concat([Buffer.from('krc1'), Buffer.from(payload.map((n, i) => n ^ key[i % 16]!))])
    const decoded = decodeLyricFile(encoded, '.krc')
    const doc = parseLyrics(decoded, 'demo.krc')
    expect(doc.cues[0]).toMatchObject({ timeMs: 1000, endMs: 3000, lines: ['你好'], wordLines: [[{ timeMs: 1000, endMs: 1500 }, { timeMs: 1500, endMs: 3000 }]] })
    expect(parseLyrics(decoded, 'demo.krc')).toEqual(doc)
  })
  it('decodes encrypted QRC and XML attribute content', () => {
    const source = '<QrcInfos><LyricInfo LyricContent="[1000,1000]你(1000,500)好(1500,500)&#10;[3000,500]再(3000,500)"/></QrcInfos>'
    const hex = encryptQrc(source)
    const doc = parseLyrics(decodeLyricFile(Buffer.from(hex), '.qrc'), 'demo.qrc')
    expect(doc.cues.map(c => c.lines)).toEqual([['你好'], ['再']])
    expect(doc.cues[0]!.wordLines![0]![1]).toEqual({ text: '好', timeMs: 1500, endMs: 2000 })
    const mask = Buffer.from('c34ad6ca9067f752d8a166629f5b0900c35e95239f13117ed8923fbc90bb740ec347743d90aa3f51d8f411849fde951dc3c609d59ffa66f9d8f0f7a090a1d6f3c3f3d6a190a0f7f0d8f966fa9fd509c6c31d95de9f8411f4d8513faa903d7447c30e74bb90bc3f92d87e11139f23955ec300095b9f6266a1d852f76790cad64a', 'hex')
    const local = Buffer.concat([Buffer.alloc(11), Buffer.from(hex, 'hex')]).map((n, i) => n ^ mask[i & 0x7f]!)
    expect(parseLyrics(decodeLyricFile(Buffer.from(local), '.qrc'), 'demo.qrc')).toEqual(doc)
  })
  it('reads SRT and VTT cues with end times, multiline captions and silent gaps', () => {
    for (const extension of ['srt', 'vtt']) {
      const doc = parseLyrics('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000 align:start\n<b>Hello</b> &amp; 你好\n译文\n\n00:03.000 --> 00:04.000\nNext', `demo.${extension}`)
      expect(doc.cues[0]).toEqual({ timeMs: 1000, endMs: 2000, lines: ['Hello & 你好', '译文'] })
      expect(lyricFrameAt(doc.cues, 2500).current).toBeNull()
      expect(lyricFrameAt(doc.cues, 4500).current).toBeNull()
    }
  })
  it('handles TTML namespaces, inherited timing, duration, spans and XML entities', () => {
    const doc = parseLyrics('<tt xmlns="http://www.w3.org/ns/ttml"><body begin="1s"><div><p begin="1s" dur="2s"><span begin="0s" dur=".5s">你</span><span begin=".5s" dur="1.5s">好&amp;</span></p></div></body></tt>', 'demo.ttml')
    expect(doc.cues[0]).toMatchObject({ timeMs: 2000, endMs: 4000, lines: ['你好&'], wordLines: [[{ text: '你', timeMs: 2000, endMs: 2500 }, { text: '好&', timeMs: 2500, endMs: 4000 }]] })
  })
  it('rejects unsupported formats, malformed XML, external entities and corrupt binaries', () => {
    expect(() => parseLyrics('abc', 'x.txt')).toThrow('UNSUPPORTED_LYRICS_FORMAT')
    expect(() => parseLyrics('<tt><p>', 'x.ttml')).toThrow()
    expect(() => parseLyrics('<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///secret">]><tt/>', 'x.ttml')).toThrow()
    expect(() => decodeLyricFile(Buffer.from('krc1broken'), '.krc')).toThrow('LYRICS_DECODE_FAILED')
  })
})
