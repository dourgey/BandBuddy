// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultEffectChain } from '../packages/shared/src/arsenal.js'
import { RecordingEffects } from '../src/renderer/src/arsenal/RecordingEffects.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { createDefaultRecordingTrackState } from '../packages/shared/src/domain.js'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('returns to file playback after capture without reopening live monitoring', async () => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  const track = { ...createDefaultRecordingTrackState('song', 'track'), activeTakeId: 'take', effects: { enabled: true, presetId: null, chain: defaultEffectChain(), monitorMode: 'wet' as const } }
  const monitor = vi.spyOn(window.bandbuddy.arsenal, 'monitor'), set = vi.spyOn(window.bandbuddy.arsenal, 'setTrack')
  const view = render(<RecordingEffects track={track} busy={false} recording />)
  await screen.findByRole('combobox')
  view.rerender(<RecordingEffects track={track} busy={false} recording={false} />)
  await waitFor(() => expect(screen.getByTitle('监听输入').getAttribute('aria-pressed')).toBe('false'))
  expect(monitor).not.toHaveBeenCalled()
  expect(set).not.toHaveBeenCalled()
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
})
it('selects tone without starting monitoring, and independently monitors the input with no recording', async () => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  const track = { ...createDefaultRecordingTrackState('song', 'track'), name: '吉他录音', activeTakeId: 'dry-take' }
  const preset = await window.bandbuddy.arsenal.savePreset({ name: '我的音色', chain: defaultEffectChain() })
  const set = vi.spyOn(window.bandbuddy.arsenal, 'setTrack'), onChanged = vi.fn()
  render(<RecordingEffects track={track} busy={false} onChanged={onChanged} />)
  await screen.findByRole('option', { name: preset.name })
  fireEvent.change(screen.getByRole('combobox', { name: '吉他录音 音色预设' }), { target: { value: preset.id } })
  await waitFor(() => expect(set).toHaveBeenCalledWith({ trackId: 'track', effects: { enabled: true, presetId: preset.id, chain: preset.chain, monitorMode: 'off' } }))
  expect(track.activeTakeId).toBe('dry-take')
  fireEvent.click(screen.getByRole('button', { name: '吉他录音监听' }))
  await waitFor(() => expect(set.mock.calls.at(-1)?.[0].effects.monitorMode).toBe('wet'))
  await waitFor(() => expect(screen.getByRole('button', { name: '吉他录音监听' }).getAttribute('aria-pressed')).toBe('true'))
  fireEvent.click(screen.getByRole('button', { name: '吉他录音监听' }))
  await waitFor(() => expect(set.mock.calls.at(-1)?.[0].effects.monitorMode).toBe('off'))
  expect(set.mock.calls.at(-1)?.[0].effects.enabled).toBe(true)
  expect(screen.queryByRole('combobox', { name: '吉他录音 监听方式' })).toBeNull()
  expect(onChanged).toHaveBeenCalled()
})
