// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { VolumeControl } from '../src/renderer/src/components/VolumeControl.js'
import { WheelNumberInput } from '../src/renderer/src/components/WheelNumberInput.js'
import { createTempoWheel } from '../src/renderer/src/components/tempo-wheel.js'
afterEach(cleanup)
it('wheel works over both button and slider, clamps and restores the last audible gain', () => {
  function Harness(): React.JSX.Element { const [v, set] = useState(-6); return <VolumeControl label="总音量" value={v} onChange={set} /> }
  render(<Harness />)
  const slider = screen.getByRole('slider', { hidden: true }) as HTMLInputElement
  fireEvent.wheel(screen.getByRole('button'), { deltaY: -100 })
  expect(Number(slider.value)).toBe(Math.round(100 * 10 ** (-5.5 / 20)))
  fireEvent.wheel(slider, { deltaY: -100 })
  fireEvent.click(screen.getByRole('button'))
  expect(slider.value).toBe('0')
  fireEvent.click(screen.getByRole('button'))
  expect(Number(slider.value)).toBe(Math.round(100 * 10 ** (-5 / 20)))
  fireEvent.doubleClick(slider)
  expect(slider.value).toBe('100')
})
it('BPM wheel prevents page scroll, clamps and respects disabled state', () => {
  const change = vi.fn()
  const { rerender } = render(<WheelNumberInput type="number" value={239} min={30} max={240} step={1} onWheelValue={change} onChange={vi.fn()} />)
  const input = screen.getByRole('spinbutton')
  const event = new WheelEvent('wheel', { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true })
  input.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(change).toHaveBeenLastCalledWith(240)
  rerender(<WheelNumberInput type="number" value={30} min={30} max={240} step={1} disabled onWheelValue={change} onChange={vi.fn()} />)
  change.mockClear()
  fireEvent.wheel(input, { deltaY: 100 })
  expect(change).not.toHaveBeenCalled()
})

it('slow scrolling is precise, fast scrolling accelerates, and reversing or pausing restores precision', () => {
  const tempo = createTempoWheel()
  const scroll = (timeStamp: number, deltaY = -100, deltaMode = 0): number => tempo.delta({ timeStamp, deltaY, deltaMode })
  expect([scroll(1000), scroll(1400), scroll(1800)]).toEqual([1, 1, 1])
  const fast = [scroll(1840), scroll(1880), scroll(1920), scroll(1960)]
  expect(fast[0]).toBeGreaterThan(1)
  expect(fast.at(-1)).toBeGreaterThan(fast[0]!)
  expect(fast.every(step => step <= 10)).toBe(true)
  expect(scroll(1980, 100)).toBe(-1)
  expect(scroll(2400)).toBe(1)
  tempo.reset()
  expect(scroll(2420)).toBe(1)
  tempo.reset()
  expect(scroll(2440, -2.5, 1)).toBe(1)
  tempo.reset()
  expect(scroll(2460, -0.125, 2)).toBe(1)
})

it('hovered numeric controls work without focus, ignore Shift, accelerate and reset after leaving', () => {
  function Harness(): React.JSX.Element { const [bpm, set] = useState(100); return <WheelNumberInput type="number" value={bpm} min={30} max={240} onWheelValue={set} onChange={vi.fn()} /> }
  render(<Harness />)
  const input = screen.getByRole('spinbutton') as HTMLInputElement
  const scroll = (timeStamp: number, shiftKey = false): void => {
    const event = new WheelEvent('wheel', { deltaY: -100, shiftKey, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'timeStamp', { value: timeStamp })
    fireEvent(input, event)
  }
  expect(document.activeElement).not.toBe(input)
  scroll(1000)
  expect(input.value).toBe('101')
  scroll(1500, true)
  expect(input.value).toBe('102')
  scroll(1540)
  expect(Number(input.value)).toBeGreaterThan(103)
  const beforeLeave = Number(input.value)
  fireEvent.mouseLeave(input)
  scroll(1580)
  expect(Number(input.value)).toBe(beforeLeave + 1)
  fireEvent.wheel(document.body, { deltaY: -100 })
  expect(Number(input.value)).toBe(beforeLeave + 1)
})
