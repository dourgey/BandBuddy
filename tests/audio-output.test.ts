import { describe, expect, it, vi } from 'vitest'
import { setAudioContextOutputDevice } from '../src/renderer/src/audio-engine.js'

describe('Web Audio output routing', () => {
  it('sets the output on the shared AudioContext rather than an individual media element', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined)

    await setAudioContextOutputDevice({ setSinkId }, 'usb-interface-output')

    expect(setSinkId).toHaveBeenCalledOnce()
    expect(setSinkId).toHaveBeenCalledWith('usb-interface-output')
  })

  it('uses the empty sink ID to return the entire mix to the system default output', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined)

    await setAudioContextOutputDevice({ setSinkId }, '')

    expect(setSinkId).toHaveBeenCalledWith('')
  })

  it('does not silently fall back to the default output when explicit selection is unsupported', async () => {
    await expect(setAudioContextOutputDevice({}, 'usb-interface-output'))
      .rejects.toThrow('AUDIO_OUTPUT_DEVICE_SELECTION_UNSUPPORTED')
  })
})
