import { describe, expect, it } from 'vitest'
import { inferStemType } from '../src/main/stem-detection.js'

describe('existing stem recognition', () => {
  it.each([
    ['Song - Vocals.wav', 'vocals'],
    ['歌曲_鼓组.flac', 'drums'],
    ['demo bass.mp3', 'bass'],
    ['作品（吉他）.m4a', 'guitar'],
    ['take.keyboard.wav', 'piano'],
    ['伴奏.aac', 'other']
  ] as const)('maps %s to %s', (name, expected) => expect(inferStemType(name)).toBe(expected))

  it('leaves ambiguous files for manual classification', () => {
    expect(inferStemType('mixdown-final.wav')).toBeNull()
  })
})
