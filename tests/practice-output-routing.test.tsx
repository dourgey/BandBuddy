// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { PracticeRoom } from '../src/renderer/src/pages/PracticeRoom.js'
import { createDefaultRecordingTrackState, type RecordingTake } from '../packages/shared/src/domain.js'

vi.mock('../src/renderer/src/components/Waveform.js', () => ({
  Waveform: () => <div className="waveform" />
}))
vi.mock('../src/renderer/src/arsenal/RecordingEffects.js', () => ({ RecordingEffects: () => null }))

afterEach(cleanup)

function practiceRoomProps(song = fixtureDetail(fixtureSongs[0]!)): ComponentProps<typeof PracticeRoom> {
  return {
    song,
    practice: song.practice,
    currentMs: 0,
    playing: false,
    selectedStem: 'vocals',
    availableOutputChannelPairs: 6,
    recordingState: {
      target: 'song', phase: 'idle', sessionId: null, songId: null, recordingTrackId: null,
      sourcePositionMs: 0, countInRemaining: 0, sampleRate: 0, bufferFrames: 0,
      latencyMs: 0, xruns: 0, splitDevices: false, message: '', error: null
    },
    recordingMeter: { peak: [0, 0], rms: [0, 0], clipped: false, sourcePositionMs: 0, recording: false },
    locked: false,
    onBack: () => undefined,
    onSeek: () => undefined,
    onTogglePlayback: () => undefined,
    onRestart: () => undefined,
    onCycleLoop: () => undefined,
    onPatch: () => undefined,
    onGuitarSplit: () => undefined,
    onTrack: () => undefined,
    onSelected: () => undefined,
    onExport: () => undefined,
    onAddRecordingTrack: () => undefined,
    onEdit: () => undefined,
    onMore: () => undefined,
    onRecord: () => undefined,
    onStopRecording: () => undefined,
    onCancelRecording: () => undefined,
    onSelectTake: () => undefined,
    onUpdateTake: () => undefined,
    onDeleteTake: () => undefined,
    onRecordingTrack: () => undefined,
    onUseTakePractice: () => undefined
  }
}

describe('PracticeRoom output routing', () => {
  it('offers every detected stereo pair and persists a per-track selection', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const onTrack = vi.fn()
    render(<PracticeRoom
      {...practiceRoomProps(song)}
      onTrack={onTrack}
    />)

    const vocalsOutput = screen.getByRole('combobox', { name: '人声输出通道' })
    expect(vocalsOutput.textContent).toContain('1–2')
    expect(screen.getByText('多通道输出已启用 · 节拍器与录音预听固定到 1–2')).toBeTruthy()

    fireEvent.click(vocalsOutput)
    expect(screen.getAllByRole('option').map((option) => option.textContent))
      .toEqual(['1–2', '3–4', '5–6', '7–8', '9–10', '11–12'])

    fireEvent.click(screen.getByRole('option', { name: '5–6' }))
    expect(onTrack).toHaveBeenCalledWith('vocals', { outputChannelPair: 5 })
    // Choosing a pair closes the menu.
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('disables guitar mode with a hover explanation, then shows an anchored completion notice', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const dismiss = vi.fn()
    const { rerender } = render(<PracticeRoom {...practiceRoomProps(song)} guitarSplitPending />)

    const button = screen.getByRole('button', { name: '吉他分轨' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('tooltip').textContent).toContain('正在分轨中，请耐心等待')

    rerender(<PracticeRoom {...practiceRoomProps(song)} guitarSplitReady onDismissGuitarSplitReady={dismiss} />)
    expect(screen.getByRole('button', { name: '吉他分轨' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('status').textContent).toContain('吉他分轨已完成')
    fireEvent.click(screen.getByRole('button', { name: '关闭吉他分轨完成提示' }))
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('shows the muted style on tracks silenced by another track solo without writing mix state', () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const { rerender } = render(<PracticeRoom {...practiceRoomProps(song)} />)
    const mButtons = (): HTMLElement[] => screen.getAllByRole('button', { name: 'M' })
    const styled = (className: string): HTMLElement[] =>
      mButtons().filter((button) => button.classList.contains(className))

    expect(styled('is-implied-muted')).toHaveLength(0)
    expect(styled('active')).toHaveLength(0)

    for (const track of song.practice.tracks) {
      if (track.stemType === 'vocals') track.solo = true
    }
    rerender(<PracticeRoom {...practiceRoomProps(song)} />)

    // Every track except the soloed one looks muted.
    expect(styled('is-implied-muted')).toHaveLength(mButtons().length - 1)
    // The highlight is presentational: nothing is actually muted.
    expect(styled('active')).toHaveLength(0)
    let muted = 0
    for (const track of song.practice.tracks) if (track.muted) muted += 1
    expect(muted).toBe(0)
  })
})

describe('PracticeRoom mute restoration', () => {
  it.each([
    ['stem', false, -6], ['stem', true, -6], ['stem', true, -60],
    ['recording', false, -6], ['recording', true, -6], ['recording', true, -60]
  ] as const)('restores a %s track (muted=%s, gain=%s) and clears other solos', (kind, muted, gainDb) => {
    const song = fixtureDetail(fixtureSongs[0]!)
    song.recordingTracks = ['target', 'solo'].map((id) => ({
      ...createDefaultRecordingTrackState(song.id, id), activeTakeId: `take-${id}`
    }))
    song.recordingTakes = song.recordingTracks.map((track): RecordingTake => ({
      id: track.activeTakeId!, songId: song.id, recordingTrackId: track.id, name: 'Take 1',
      durationMs: song.durationMs, startPositionMs: 0, endPositionMs: song.durationMs,
      playbackRate: 1, pitchSemitones: 0, sampleRate: 48000, channels: 2, alignmentOffsetMs: 0,
      backend: 'wasapi', inputDeviceName: 'Input', inputChannels: [0, 1],
      deviceSnapshot: {
        backend: 'wasapi', inputDeviceId: 'input', inputDeviceName: 'Input', outputDeviceId: 'output',
        outputDeviceName: 'Output', inputChannels: [0, 1], sampleRate: 48000, bufferFrames: 256,
        latencyMs: 0, splitDevices: false, softwareMonitoring: false
      },
      sourceMediaUrl: '/take.wav', previewMediaUrl: '/take.wav', peaksUrl: null,
      interrupted: false, createdAt: '2026-10-11T00:00:00Z'
    }))
    const vocals = song.practice.tracks.find((track) => track.stemType === 'vocals')!
    const drums = song.practice.tracks.find((track) => track.stemType === 'drums')!
    const bass = song.practice.tracks.find((track) => track.stemType === 'bass')!
    drums.solo = true
    song.recordingTracks[1]!.solo = true
    bass.muted = true
    bass.gainDb = -9
    const target = kind === 'stem' ? vocals : song.recordingTracks[0]!
    Object.assign(target, { muted, gainDb })
    const onTrack = vi.fn((stem, patch) => Object.assign(song.practice.tracks.find((track) => track.stemType === stem)!, patch))
    const onRecordingTrack = vi.fn((id, patch) => Object.assign(song.recordingTracks.find((track) => track.id === id)!, patch))
    const props = { ...practiceRoomProps(song), onTrack, onRecordingTrack }
    const { rerender } = render(<PracticeRoom {...props} />)
    const key = kind === 'stem' ? 'stem:vocals' : 'recording:target'
    const button = () => document.querySelector(`[data-track-order-key="${key}"] .ms-buttons button`) as HTMLButtonElement
    expect(button().className).toBe(muted ? 'active' : 'is-implied-muted')
    fireEvent.click(button())
    expect(target).toMatchObject({ muted: false, gainDb: gainDb <= -60 ? 0 : gainDb })
    expect(drums.solo).toBe(false)
    expect(song.recordingTracks[1]!.solo).toBe(false)
    expect(bass).toMatchObject({ muted: true, gainDb: -9 })
    rerender(<PracticeRoom {...props} />)
    expect(button().className).toBe('')
    fireEvent.click(button())
    expect(target.muted).toBe(true)
    rerender(<PracticeRoom {...props} />)
    expect(button().className).toBe('active')
    fireEvent.click(button())
    expect(target.muted).toBe(false)
  })
})
