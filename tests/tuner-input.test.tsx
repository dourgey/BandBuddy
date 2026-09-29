// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Tuner } from '../src/renderer/src/woodshed/Tuner.js'
import { TUNINGS } from '../src/renderer/src/woodshed/theory.js'

afterEach(() => vi.unstubAllGlobals())

describe('tuner microphone input', () => {
  it('starts on entry, chooses the live channel and never routes it to output', async () => {
    const track = { stop: vi.fn(), getSettings: () => ({ channelCount: 2 }), onended: null }
    const media = { getAudioTracks: () => [track], getTracks: () => [track] }
    const getUserMedia = vi.fn().mockResolvedValue(media)
    vi.stubGlobal('navigator', { mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    } })
    const sourceConnect = vi.fn()
    const splitterConnect = vi.fn()
    let analyserIndex = 0
    const close = vi.fn().mockResolvedValue(undefined)
    const destination = { name: 'output' }
    class FakeAudioContext {
      sampleRate = 48000
      destination = destination
      resume = vi.fn().mockResolvedValue(undefined)
      close = close
      createMediaStreamSource = () => ({ connect: sourceConnect })
      createChannelSplitter = () => ({ connect: splitterConnect })
      createAnalyser = () => {
        const channel = analyserIndex++
        return { fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => {
          for (let i = 0; i < samples.length; i++)
            samples[i] = channel === 0 ? 0 : 0.08 * Math.sin((2 * Math.PI * 110 * i) / 48000)
        } }
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { unmount } = render(<Tuner
      presetControl={<span>吉他 · 标准</span>}
      instrumentSettings={<span>设置</span>}
      tuning={TUNINGS[0]!}
      capo={0}
      a4={440}
      onA4={vi.fn()}
      inputDevice=""
      onDevice={vi.fn()}
      inputChannel={0}
      onChannel={vi.fn()}
      onError={vi.fn()}
    />)
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /开启麦克风|关闭输入/ })).toBeNull()
    await waitFor(() => expect(screen.getByText(/麦克风监听中 · 通道 2/)).toBeTruthy())
    expect(sourceConnect).toHaveBeenCalledOnce()
    expect(sourceConnect.mock.calls[0]![0]).not.toBe(destination)
    expect(splitterConnect.mock.calls.every((call) => call[0] !== destination)).toBe(true)
    expect(splitterConnect).toHaveBeenCalledTimes(2)
    unmount()
    expect(track.stop).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})
