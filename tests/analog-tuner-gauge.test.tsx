// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnalogTunerGauge } from '../src/renderer/src/woodshed/AnalogTunerGauge.js'

afterEach(cleanup)

describe('analog tuner gauge', () => {
  it('keeps silence neutral instead of reporting accurate tuning', () => {
    const { container } = render(<AnalogTunerGauge reading={null} />)
    expect(screen.getByRole('img', { name: '音准表无有效读数' })).toBeTruthy()
    expect(screen.getByText('等待拨弦')).toBeTruthy()
    expect(screen.queryByText('准确')).toBeNull()
    expect(container.querySelector('.has-reading')).toBeNull()
  })

  it('renders live note, frequency and the three-cent accuracy boundary', () => {
    const { rerender } = render(<AnalogTunerGauge reading={{ midi: 38, hz: 73.33, cents: -2 }} />)
    expect(screen.getByText('D2')).toBeTruthy()
    expect(screen.getByText('73.33 Hz')).toBeTruthy()
    expect(screen.getByText('-2 ¢')).toBeTruthy()
    expect(screen.getByText('准确')).toBeTruthy()
    rerender(<AnalogTunerGauge reading={{ midi: 38, hz: 73.6, cents: 4 }} />)
    expect(screen.getByText('稍高')).toBeTruthy()
    rerender(<AnalogTunerGauge reading={{ midi: 38, hz: 73, cents: -4 }} />)
    expect(screen.getByText('稍低')).toBeTruthy()
  })

  it('uses independent glass and metal definitions when multiple gauges mount', () => {
    const { container } = render(<><AnalogTunerGauge reading={null} /><AnalogTunerGauge reading={null} /></>)
    const ids = Array.from(container.querySelectorAll('[id]'), (node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(container.querySelectorAll('svg[viewBox="0 0 1000 650"]')).toHaveLength(4)
  })
})
