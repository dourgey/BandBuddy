// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArsenalPage } from '../src/renderer/src/pages/ArsenalPage.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { resetArsenalWorkspace, useArsenal } from '../src/renderer/src/arsenal/workspace-store.js'
beforeEach(()=>{resetArsenalWorkspace();localStorage.clear();Object.defineProperty(window,'bandbuddy',{configurable:true,writable:true,value:undefined});installFixtureBridge();Element.prototype.scrollIntoView=vi.fn();HTMLElement.prototype.showPopover=function(){this.style.display='block'}})
afterEach(()=>{cleanup();resetArsenalWorkspace();vi.restoreAllMocks()})
async function ready(){await waitFor(()=>expect(useArsenal.getState().ready).toBe(true))}
function choose(label:string,name:string){fireEvent.click(screen.getByRole('combobox',{name:label}));fireEvent.click(screen.getByRole('option',{name,exact:true}))}
it('edits distinct repeated modules, reorders and saves their effective controls',async()=>{
 const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset');render(<ArsenalPage onToast={()=>undefined}/>);await ready()
 fireEvent.click(screen.getByRole('button',{name:'新建预设'}));fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}));choose('单块型号','BOSS DS-1 风格')
 const knob=screen.getByRole('slider',{name:'Drive'});act(()=>knob.focus());fireEvent.wheel(knob,{deltaY:-100,shiftKey:true});expect(knob.getAttribute('aria-valuenow')).toBe('4.1')
 fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}));choose('单块型号','SD-1 · 不对称过载');fireEvent.click(screen.getByRole('button',{name:'模块前移'}))
 fireEvent.change(screen.getByRole('textbox',{name:'预设名称'}),{target:{value:'双过载'}});fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));await waitFor(()=>expect(save).toHaveBeenCalled())
 const p=save.mock.calls.at(-1)![0];expect(p.name).toBe('双过载');expect(p.chain.modules?.map(m=>m.settings.drive.device)).toEqual(['sd1','ds1']);expect(new Set(p.chain.modules?.map(m=>m.id)).size).toBe(2);expect(p.chain.modules?.[1]?.settings.drive.drive).toBeCloseTo(.41)
})
it('preserves independent AMP/CAB, draft and monitoring across unmount; only explicit stop closes it',async()=>{
 const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor');const view=render(<ArsenalPage onToast={()=>undefined}/>);await ready()
 fireEvent.click(screen.getByRole('button',{name:'新建预设'}));fireEvent.click(screen.getByRole('button',{name:'AMP',exact:true}));choose('箱头型号','英式过载');fireEvent.click(screen.getByRole('button',{name:'CAB',exact:true}));choose('箱体型号','C12N · 4×12 密闭')
 expect(useArsenal.getState().draft.chain.modules?.map(m=>m.type)).toEqual(['amp','cab']);fireEvent.click(screen.getByRole('button',{name:'效果',exact:true}));await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].mode).toBe('wet'))
 view.unmount();await new Promise(r=>setTimeout(r,300));expect(monitor.mock.calls.some(([i])=>i.mode==='off')).toBe(false)
 render(<ArsenalPage onToast={()=>undefined}/>);expect(useArsenal.getState().draft.chain.modules?.map(m=>m.type)).toEqual(['amp','cab']);fireEvent.click(screen.getByRole('button',{name:'关闭',exact:true}));await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].mode).toBe('off'))
})
it('supports history and reversible A/B without overwriting the user preset',async()=>{
 render(<ArsenalPage onToast={()=>undefined}/>);await ready();fireEvent.click(screen.getByRole('button',{name:'存 A'}));const original=screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')
 fireEvent.change(screen.getByRole('spinbutton',{name:'GAIN 数值'}),{target:{value:'7'}});fireEvent.click(screen.getByRole('button',{name:'B 对比'}));expect(screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')).toBe(original)
 fireEvent.click(screen.getByRole('button',{name:'A 对比'}));expect(screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')).toBe('7');fireEvent.click(screen.getByRole('button',{name:'撤销'}));expect(screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')).toBe(original)
})
