import { describe, expect, it } from 'vitest'
import { selectInputChannel } from '../src/renderer/src/woodshed/input-channel.js'
import { decodePreferences, defaults } from '../src/renderer/src/woodshed/preferences.js'

describe('tuner input channel selection', () => {
  it('chooses the channel with an input signal', () => {
    expect(selectInputChannel([0.0002, 0.08], 0, 0)).toBe(1)
  })
  it('keeps an active channel when levels are close', () => {
    expect(selectInputChannel([0.05, 0.07], 0, 0)).toBe(0)
  })
  it('honors a manually chosen channel even when it is quiet', () => {
    expect(selectInputChannel([0.08, 0], 0, 2)).toBe(1)
  })
  it('stays on the previous channel when all inputs are silent', () => {
    expect(selectInputChannel([0, 0], 1, 0)).toBe(1)
  })
  it('keeps existing saved preferences when the new channel setting is absent', () => {
    const saved = defaults()
    const old = { ...saved } as Partial<typeof saved>
    delete old.inputChannel
    expect(decodePreferences(JSON.stringify(old)).inputChannel).toBe(0)
  })
})
