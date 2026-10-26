// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Knob } from '../src/renderer/src/arsenal/Knob.js'
afterEach(cleanup)
function Harness(): React.JSX.Element { const [v,set]=useState(5);return <Knob label="Gain" value={v} min={0} max={10} step={.1} onChange={set}/> }
it('hover wheel works on knob, label and value without focus and prevents parent scrolling',()=>{
  render(<Harness/>);const slider=screen.getByRole('slider'),input=screen.getByRole('spinbutton')
  expect(document.activeElement).not.toBe(slider)
  for(const target of [slider,screen.getByText('Gain'),input]){
    const before=Number(slider.getAttribute('aria-valuenow')),event=new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true})
    fireEvent(target,event);expect(event.defaultPrevented).toBe(true);expect(Number(slider.getAttribute('aria-valuenow'))).toBeCloseTo(before+.5)
  }
  fireEvent.wheel(slider,{deltaY:100,shiftKey:true});expect(slider.getAttribute('aria-valuenow')).toBe('6.4')
  fireEvent.wheel(document.body,{deltaY:-100});expect(slider.getAttribute('aria-valuenow')).toBe('6.4')
})
it('does not lose rapid wheel updates, clamps, and ignores zoom or horizontal gestures',()=>{
  render(<Harness/>);const slider=screen.getByRole('slider')
  act(()=>{for(let n=0;n<3;n++)slider.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}))})
  expect(slider.getAttribute('aria-valuenow')).toBe('6.5')
  for(const e of [{deltaY:0},{deltaY:-1,deltaX:20},{deltaY:-100,ctrlKey:true},{deltaY:-100,metaKey:true}])fireEvent.wheel(slider,e)
  expect(slider.getAttribute('aria-valuenow')).toBe('6.5')
  for(let n=0;n<25;n++)fireEvent.wheel(slider,{deltaY:-100});expect(slider.getAttribute('aria-valuenow')).toBe('10')
  fireEvent.keyDown(slider,{key:'Home'});fireEvent.wheel(slider,{deltaY:100});expect(slider.getAttribute('aria-valuenow')).toBe('0')
})
it('respects disabled controls and quantizes relative to the minimum',()=>{
  const change=vi.fn();const {rerender}=render(<Knob label="Rate" value={.15} min={.05} max={1.05} step={.1} disabled onChange={change}/>)
  const slider=screen.getByRole('slider');fireEvent.wheel(slider,{deltaY:-100});fireEvent.keyDown(slider,{key:'End'});expect(change).not.toHaveBeenCalled()
  rerender(<Knob label="Rate" value={.15} min={.05} max={1.05} step={.1} onChange={change}/>)
  fireEvent.wheel(slider,{deltaY:-100,shiftKey:true});expect(change).toHaveBeenLastCalledWith(.25)
})
