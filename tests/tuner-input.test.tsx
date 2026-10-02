// @vitest-environment jsdom
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Tuner } from '../src/renderer/src/woodshed/Tuner.js'
import { TUNINGS } from '../src/renderer/src/woodshed/theory.js'
import { defaults, readPreferences, savePreferences } from '../src/renderer/src/woodshed/preferences.js'

afterEach(() => vi.unstubAllGlobals())

describe('tuner microphone input', () => {
  it('falls back only when a saved input is unavailable and persists the replacement for re-entry', async () => {
    localStorage.clear()
    savePreferences({ ...defaults(), inputDevice: 'missing-usb' })
    const track = { stop: vi.fn(), getSettings: () => ({ channelCount: 1, deviceId: 'backup-usb' }), onended: null }
    const media = { getAudioTracks: () => [track], getTracks: () => [track] }
    const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException('missing', 'NotFoundError')).mockResolvedValue(media)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'backup-usb', label: '备用声卡' }]),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    } })
    class Context {
      sampleRate = 48000
      resume = async () => {}
      close = async () => {}
      createMediaStreamSource = () => ({ connect: vi.fn() })
      createChannelSplitter = () => ({ connect: vi.fn() })
      createAnalyser = () => ({ fftSize: 8192, getFloatTimeDomainData: (data: Float32Array) => data.fill(0) })
    }
    vi.stubGlobal('AudioContext', Context)
    function Harness(): React.JSX.Element {
      const [prefs, setPrefs] = useState(readPreferences)
      return <Tuner presetControl={<span>吉他</span>} instrumentSettings={null} tuning={TUNINGS[0]!} capo={0} a4={440}
        onA4={vi.fn()} inputDevice={prefs.inputDevice} onDevice={inputDevice => { const updated = { ...prefs, inputDevice }; savePreferences(updated); setPrefs(updated) }}
        inputChannel={0} onChannel={vi.fn()} onError={vi.fn()} />
    }
    const first = render(<Harness />)
    await waitFor(() => expect(readPreferences().inputDevice).toBe('backup-usb'))
    await waitFor(() => expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: 'backup-usb' } }) })))
    expect(getUserMedia.mock.calls[0]![0].audio.deviceId).toEqual({ exact: 'missing-usb' })
    expect(getUserMedia.mock.calls[1]![0].audio.deviceId).toBeUndefined()
    first.unmount()
    getUserMedia.mockClear()
    const second = render(<Harness />)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
    expect(getUserMedia.mock.calls[0]![0].audio.deviceId).toEqual({ exact: 'backup-usb' })
    second.unmount()
    localStorage.clear()
  })
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
    await waitFor(() => expect(screen.getByText(/通道 2/)).toBeTruthy())
    expect(sourceConnect).toHaveBeenCalledOnce()
    expect(sourceConnect.mock.calls[0]![0]).not.toBe(destination)
    expect(splitterConnect.mock.calls.every((call) => call[0] !== destination)).toBe(true)
    expect(splitterConnect).toHaveBeenCalledTimes(2)
    unmount()
    expect(track.stop).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})
