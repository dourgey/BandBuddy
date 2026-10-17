import { describe, expect, it } from 'vitest'
import {
  createDefaultPracticeState,
  dbToGain,
  isTrackAudible,
  moveTrackOrder,
  normalizeTrackStates,
  normalizeTrackOrder,
  parseMusicalKey,
  recordingTrackOrderKey,
  stemTrackOrderKey,
  transposeMusicalKey,
  visibleStemTypes
} from '@shared/domain.js'

describe('track mix rules', () => {
  it('starts every song at its original key', () => {
    expect(createDefaultPracticeState('00000000-0000-4000-8000-000000000000').pitchSemitones).toBe(0)
  })

  it('lets mute override solo and supports multiple solos', () => {
    const tracks = createDefaultPracticeState('00000000-0000-4000-8000-000000000000').tracks
    tracks[0]!.solo = true
    tracks[1]!.solo = true
    tracks[1]!.muted = true
    expect(isTrackAudible(tracks[0]!, tracks)).toBe(true)
    expect(isTrackAudible(tracks[1]!, tracks)).toBe(false)
    expect(isTrackAudible(tracks[2]!, tracks)).toBe(false)
  })

  it('excludes hidden guitar alternatives from visibility and Solo decisions', () => {
    const tracks = createDefaultPracticeState('00000000-0000-4000-8000-000000000000').tracks
    tracks.find((track) => track.stemType === 'guitar')!.solo = true
    expect(visibleStemTypes(false)).toEqual(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'])
    expect(visibleStemTypes(true)).toEqual([
      'vocals', 'drums', 'bass', 'acoustic_guitar', 'lead_guitar', 'rhythm_guitar', 'piano', 'other'
    ])
    expect(isTrackAudible(tracks.find((track) => track.stemType === 'guitar')!, tracks, true)).toBe(false)
    expect(isTrackAudible(tracks.find((track) => track.stemType === 'vocals')!, tracks, true)).toBe(true)
  })

  it('converts dB to linear gain and treats the floor as silence', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(6)).toBeCloseTo(1.995262, 5)
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 5)
    expect(dbToGain(-60)).toBe(0)
  })

  it('normalizes and moves stem and recording tracks in one saved order', () => {
    const recordingId = '11111111-1111-4111-8111-111111111111'
    const order = normalizeTrackOrder(
      [recordingTrackOrderKey(recordingId), stemTrackOrderKey('drums'), stemTrackOrderKey('drums')],
      [recordingId]
    )

    expect(order[0]).toBe(recordingTrackOrderKey(recordingId))
    expect(order[1]).toBe(stemTrackOrderKey('drums'))
    expect(new Set(order).size).toBe(12)
    expect(order.slice(order.indexOf(stemTrackOrderKey('guitar')) + 1, order.indexOf(stemTrackOrderKey('guitar')) + 4)).toEqual([
      stemTrackOrderKey('acoustic_guitar'),
      stemTrackOrderKey('lead_guitar'),
      stemTrackOrderKey('rhythm_guitar')
    ])
    expect(moveTrackOrder(order, stemTrackOrderKey('vocals'), recordingTrackOrderKey(recordingId), 'before')[0])
      .toBe(stemTrackOrderKey('vocals'))
  })

  it('upgrades old saved tracks to the default output pair without losing mix state', () => {
    const tracks = normalizeTrackStates([
      { stemType: 'vocals', gainDb: -4, muted: true, solo: false },
      { stemType: 'drums', gainDb: 1, muted: false, solo: true, outputChannelPair: 5 }
    ])

    expect(tracks).toHaveLength(11)
    expect(tracks.find((track) => track.stemType === 'vocals')).toMatchObject({
      gainDb: -4,
      muted: true,
      outputChannelPair: 1
    })
    expect(tracks.find((track) => track.stemType === 'drums')?.outputChannelPair).toBe(5)
    expect(tracks.find((track) => track.stemType === 'acoustic_guitar')).toMatchObject({ gainDb: 0, muted: false, solo: false })
  })

  it('normalizes compact key names and transposes them by semitone', () => {
    expect(parseMusicalKey('Em')).toEqual({ tonic: 'E', mode: 'minor', label: 'E minor' })
    expect(parseMusicalKey('Bb major')?.label).toBe('B♭ major')
    expect(transposeMusicalKey('E♭ minor', 2)).toBe('F minor')
    expect(transposeMusicalKey('B major', 1)).toBe('C major')
  })
})
