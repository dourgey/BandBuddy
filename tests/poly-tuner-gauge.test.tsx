// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PolyTunerGauge } from '../src/renderer/src/woodshed/PolyTunerGauge.js'

const notes = [38, 45, 50, 55, 59, 64]
const pitch = (index: number, cents: number) => ({ midi: notes[index]!, hz: 100, cents, confidence: .9 })
afterEach(cleanup)

describe('polyphonic instrument display', () => {
  it('preserves six ordered notes and does not imply a reading for silent strings', () => {
    const { container } = render(<PolyTunerGauge notes={notes} capo={0} readings={[]} />)
    expect(Array.from(container.querySelectorAll('.ws-tuner-poly-string b'), (node) => node.textContent))
      .toEqual(['D2', 'A2', 'D3', 'G3', 'B3', 'E4'])
    expect(screen.getAllByText('未检测')).toHaveLength(6)
    expect(screen.queryAllByRole('meter')).toHaveLength(0)
    expect(container.querySelectorAll('.ws-tuner-poly-indicator')).toHaveLength(0)
  })

  it('distinguishes accurate, flat, sharp and missing readings without extra interactive controls', () => {
    const { container } = render(<PolyTunerGauge notes={notes} capo={0}
      readings={[pitch(0, -7), pitch(1, 3), pitch(2, 0), pitch(3, 9), null, pitch(5, -3)]} />)
    expect(screen.getAllByText('准确')).toHaveLength(3)
    expect(screen.getByText('稍低')).toBeTruthy()
    expect(screen.getByText('稍高')).toBeTruthy()
    expect(screen.getByText('未检测')).toBeTruthy()
    expect(screen.getByRole('meter', { name: 'D2 音分偏差' }).getAttribute('aria-valuenow')).toBe('-7')
    expect(container.querySelectorAll('.ws-tuner-poly-glass')).toHaveLength(1)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('clamps end stops and optical stems while retaining the measured deviation text', () => {
    const { container } = render(<PolyTunerGauge notes={notes} capo={2}
      readings={[pitch(0, -72), pitch(1, 61)]} />)
    expect(screen.getByText('E2')).toBeTruthy()
    expect(screen.getByText('-72 ¢')).toBeTruthy()
    expect(screen.getByText('+61 ¢')).toBeTruthy()
    const carriages = container.querySelectorAll<HTMLElement>('.ws-tuner-poly-carriage')
    expect(Array.from(carriages, (node) => node.style.bottom)).toEqual(['0%', '100%'])
    const stems = container.querySelectorAll<HTMLElement>('.ws-tuner-poly-travel')
    expect(Array.from(stems, (node) => [node.style.bottom, node.style.height])).toEqual([['0%', '20%'], ['80%', '20%']])
  })
})
