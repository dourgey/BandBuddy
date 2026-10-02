// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RecordingEffects } from '../src/renderer/src/arsenal/RecordingEffects.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { createDefaultRecordingTrackState } from '../packages/shared/src/domain.js'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('selects a saved preset for wet monitoring and changes sound without replacing the dry take', async () => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  const track = { ...createDefaultRecordingTrackState('song', 'track'), name: '吉他录音', activeTakeId: 'dry-take' }
  const preset = (await window.bandbuddy.arsenal.list()).presets[0]!
  const set = vi.spyOn(window.bandbuddy.arsenal, 'setTrack'), onChanged = vi.fn()
  render(<RecordingEffects track={track} busy={false} onChanged={onChanged} />)
  await screen.findByRole('option', { name: preset.name })
  fireEvent.change(screen.getByRole('combobox', { name: '吉他录音 音色预设' }), { target: { value: preset.id } })
  await waitFor(() => expect(set).toHaveBeenCalledWith({ trackId: 'track', effects: { enabled: true, presetId: preset.id, chain: preset.chain, monitorMode: 'wet' } }))
  expect(track.activeTakeId).toBe('dry-take')
  fireEvent.change(screen.getByRole('combobox', { name: '吉他录音 监听方式' }), { target: { value: 'off' } })
  await waitFor(() => expect(set.mock.calls.at(-1)?.[0].effects.monitorMode).toBe('off'))
  expect(set.mock.calls.at(-1)?.[0].effects.enabled).toBe(true)
  expect(onChanged).toHaveBeenCalled()
})
