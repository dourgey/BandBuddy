// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArsenalPage } from '../src/renderer/src/pages/ArsenalPage.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { choosePreset, editDraft, preparePluginEditor, selectModule, setMonitor, resetArsenalWorkspace, useArsenal } from '../src/renderer/src/arsenal/workspace-store.js'
import { chainNodes } from '@shared/arsenal.js'
beforeEach(()=>{resetArsenalWorkspace();localStorage.clear();Object.defineProperty(window,'bandbuddy',{configurable:true,writable:true,value:undefined});installFixtureBridge();Element.prototype.scrollIntoView=vi.fn();HTMLElement.prototype.showPopover=function(){this.style.display='block'}})
afterEach(()=>{cleanup();resetArsenalWorkspace();vi.restoreAllMocks()})
async function ready(){await waitFor(()=>expect(useArsenal.getState().ready).toBe(true))}
function choose(label:string,name:string){fireEvent.click(screen.getByRole('combobox',{name:label}));fireEvent.click(screen.getByRole('option',{name,exact:true}))}
it('treats VST as an ordinary rack node for adding, moving, bypass, copy, undo, save and removal',async()=>{
 const plugin={format:'vst3' as const,pluginId:'delay',name:'测试 VST',manufacturer:'Test',version:'1',path:'test.vst3',fingerprint:'a'.repeat(64),architecture:'x64',instrument:false,validation:'available' as const,hasEditor:true}
 const catalog={version:1 as const,plugins:[plugin],directories:[],failures:[]}
 window.bandbuddy.audioPlugins={list:vi.fn().mockResolvedValue(catalog),scan:vi.fn().mockResolvedValue(catalog),editor:vi.fn().mockResolvedValue(undefined),save:vi.fn().mockResolvedValue('b'.repeat(64))} as never
 const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset')
 const view=render(<ArsenalPage onToast={()=>undefined}/>);await ready()
 fireEvent.click(screen.getByRole('button',{name:'新建预设'}));fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}))
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'添加 VST 插件'}) as HTMLButtonElement).disabled).toBe(false))
 choose('添加 VST 插件','测试 VST');fireEvent.click(screen.getByRole('button',{name:'CAB',exact:true}))
 const types=()=>chainNodes(useArsenal.getState().draft.chain).map(n=>n.type)
 expect(types()).toEqual(['drive','plugin','cab'])
 expect(view.container.querySelectorAll('.module-chain .type-plugin')).toHaveLength(1)
 expect(screen.queryByText('处理位置')).toBeNull();expect(view.container.querySelector('.local-plugins')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'VST测试 VST',exact:true}))
 fireEvent.click(screen.getByRole('button',{name:'模块前移'}));expect(types()).toEqual(['plugin','drive','cab'])
 fireEvent.click(screen.getByRole('button',{name:'旁通',exact:true}));expect(useArsenal.getState().draft.chain.plugins?.[0]?.bypass).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'复制模块'}));expect(types()).toEqual(['plugin','plugin','drive','cab'])
 expect(new Set(useArsenal.getState().draft.chain.plugins?.map(p=>p.instanceId)).size).toBe(2)
 fireEvent.click(screen.getByRole('button',{name:'删除模块'}));expect(types()).toEqual(['plugin','drive','cab'])
 fireEvent.click(screen.getByRole('button',{name:'撤销'}));expect(types()).toEqual(['plugin','plugin','drive','cab'])
 fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));await waitFor(()=>expect(save).toHaveBeenCalled())
 expect(chainNodes(save.mock.calls.at(-1)![0].chain).map(n=>n.type)).toEqual(types())
 const current=useArsenal.getState().draft,only=chainNodes(current.chain).find(n=>n.type==='plugin')!
 act(()=>choosePreset({id:crypto.randomUUID(),name:'仅插件',chain:{...current.chain,modules:[],plugins:current.chain.plugins!.slice(0,1)},revision:1,createdAt:'',updatedAt:''}))
 expect(useArsenal.getState().draft.selected).toBe(only.id)
 expect(await screen.findByRole('button',{name:'打开插件'})).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'删除模块'}));expect(useArsenal.getState().draft.selected).toBe('')
})
it('edits distinct repeated modules, reorders and saves their effective controls',async()=>{
 const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset');render(<ArsenalPage onToast={()=>undefined}/>);await ready()
 fireEvent.click(screen.getByRole('button',{name:'新建预设'}));fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}));choose('单块型号','Hard Dist 01')
 const knob=screen.getByRole('slider',{name:'Drive'});act(()=>knob.focus());fireEvent.wheel(knob,{deltaY:-100,shiftKey:true});expect(knob.getAttribute('aria-valuenow')).toBe('4.1')
 fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}));choose('单块型号','Super OD 01');fireEvent.click(screen.getByRole('button',{name:'模块前移'}))
 fireEvent.change(screen.getByRole('textbox',{name:'预设名称'}),{target:{value:'双过载'}});fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));await waitFor(()=>expect(save).toHaveBeenCalled())
 const p=save.mock.calls.at(-1)![0];expect(p.name).toBe('双过载');expect(p.chain.modules?.map(m=>m.settings.drive.device)).toEqual(['sd1','ds1']);expect(new Set(p.chain.modules?.map(m=>m.id)).size).toBe(2);expect(p.chain.modules?.[1]?.settings.drive.drive).toBeCloseTo(.41)
})
it('preserves independent AMP/CAB, draft and monitoring across unmount; only explicit stop closes it',async()=>{
 const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor');const view=render(<ArsenalPage onToast={()=>undefined}/>);await ready()
 fireEvent.click(screen.getByRole('button',{name:'新建预设'}));fireEvent.click(screen.getByRole('button',{name:'AMP',exact:true}));choose('箱头型号','Brit 800');fireEvent.click(screen.getByRole('button',{name:'CAB',exact:true}));choose('箱体型号','4x12 Brit G25')
 expect(useArsenal.getState().draft.chain.modules?.map(m=>m.type)).toEqual(['amp','cab']);fireEvent.click(screen.getByRole('button',{name:'效果',exact:true}));await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].mode).toBe('wet'))
 view.unmount();await new Promise(r=>setTimeout(r,300));expect(monitor.mock.calls.some(([i])=>i.mode==='off')).toBe(false)
 render(<ArsenalPage onToast={()=>undefined}/>);expect(useArsenal.getState().draft.chain.modules?.map(m=>m.type)).toEqual(['amp','cab']);fireEvent.click(screen.getByRole('button',{name:'关闭',exact:true}));await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].mode).toBe('off'))
})
it('supports history and reversible A/B without overwriting the user preset',async()=>{
 render(<ArsenalPage onToast={()=>undefined}/>);await ready();fireEvent.click(screen.getByRole('button',{name:'AMP',exact:true}));fireEvent.click(screen.getByRole('button',{name:'存 A'}));const original=screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')
 fireEvent.change(screen.getByRole('spinbutton',{name:'GAIN 数值'}),{target:{value:'7'}});fireEvent.click(screen.getByRole('button',{name:'B 对比'}));expect(screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')).toBe(original)
 fireEvent.click(screen.getByRole('button',{name:'A 对比'}));expect(screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')).toBe('7');fireEvent.click(screen.getByRole('button',{name:'撤销'}));expect(screen.getByRole('slider',{name:'GAIN'}).getAttribute('aria-valuenow')).toBe(original)
})

it('opens a VST immediately on adding or clicking its rack card, including repeated clicks',async()=>{
 const plugin={format:'vst3' as const,pluginId:'delay',name:'窗口测试',manufacturer:'Test',version:'1',path:'test.vst3',fingerprint:'a'.repeat(64),architecture:'x64',instrument:false,validation:'available' as const,hasEditor:true}
 const catalog={version:1 as const,plugins:[plugin],directories:[],failures:[]}
 const editor=vi.fn().mockResolvedValue(undefined)
 window.bandbuddy.audioPlugins={list:vi.fn().mockResolvedValue(catalog),scan:vi.fn().mockResolvedValue(catalog),editor} as never
 const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor')
 render(<ArsenalPage onToast={()=>undefined}/>);await ready()
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'添加 VST 插件'}) as HTMLButtonElement).disabled).toBe(false))
 choose('添加 VST 插件','窗口测试')
 await waitFor(()=>expect(editor).toHaveBeenCalledOnce())
 const id=useArsenal.getState().draft.chain.plugins![0]!.instanceId
 expect(editor).toHaveBeenLastCalledWith(id)
 expect(monitor.mock.calls.at(-1)![0].chain.plugins![0]!.instanceId).toBe(id)
 await waitFor(()=>expect((screen.getByRole('button',{name:'打开插件'}) as HTMLButtonElement).disabled).toBe(false))
 fireEvent.click(screen.getByRole('button',{name:'VST窗口测试',exact:true}))
 await waitFor(()=>expect(editor).toHaveBeenCalledTimes(2))
 expect(editor).toHaveBeenLastCalledWith(id)
})
it('persists rack selection without sending an audio update',async()=>{
 vi.useFakeTimers()
 try {
  useArsenal.setState({monitor:{...useArsenal.getState().monitor,active:true,mode:'wet'}})
  const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor'),command=vi.spyOn(window.bandbuddy.arsenal,'command')
  selectModule('selected')
  await vi.advanceTimersByTimeAsync(300)
  expect(monitor).not.toHaveBeenCalled()
  expect(command).toHaveBeenCalledWith(expect.objectContaining({action:'draft',draft:expect.objectContaining({selected:'selected'})}))
 } finally {vi.useRealTimers()}
})
it('waits for an in-flight audio graph update and then flushes the latest chain before opening',async()=>{
 vi.useFakeTimers()
 try {
  const state={...useArsenal.getState().monitor,active:true,mode:'wet' as const}
  useArsenal.setState({monitor:state})
  let finish!:()=>void
  const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor').mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>resolve(state)})).mockResolvedValue(state)
  editDraft({chain:{...useArsenal.getState().draft.chain,inputGainDb:-1}})
  await vi.advanceTimersByTimeAsync(100)
  editDraft({chain:{...useArsenal.getState().draft.chain,inputGainDb:-2}})
  const prepared=preparePluginEditor()
  await Promise.resolve();expect(monitor).toHaveBeenCalledOnce()
  finish();await prepared
  expect(monitor).toHaveBeenCalledTimes(2)
  expect(monitor.mock.calls[1]![0].chain.inputGainDb).toBe(-2)
  await vi.advanceTimersByTimeAsync(300)
  expect(monitor).toHaveBeenCalledTimes(2)
 } finally {vi.useRealTimers()}
})
it('waits through a monitor mode transition before preparing the wet plugin chain',async()=>{
 const state={...useArsenal.getState().monitor,active:true,mode:'dry' as const}
 useArsenal.setState({monitor:state})
 let finish!:(value:typeof state)=>void
 const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue({...state,mode:'wet'})
 const switching=setMonitor('dry'),prepared=preparePluginEditor()
 await Promise.resolve();expect(monitor).toHaveBeenCalledOnce()
 finish(state);await Promise.all([switching,prepared])
 expect(monitor.mock.calls.map(([request])=>request.mode)).toEqual(['dry','wet'])
})
