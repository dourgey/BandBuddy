// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArsenalPage } from '../src/renderer/src/pages/ArsenalPage.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

beforeEach(() => {
  Object.defineProperty(window,'bandbuddy',{configurable:true,writable:true,value:undefined})
  installFixtureBridge()
  Element.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
})
afterEach(() => {cleanup();vi.restoreAllMocks()})
function choose(label: string, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}
it('selects RAT, edits controls, saves a snapshot and updates an active monitor', async () => {
  const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset')
  const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor')
  render(<ArsenalPage onToast={() => undefined} />)
  await screen.findByRole('button',{name:/干净起点/})
  fireEvent.click(screen.getByRole('button',{name:'白盒设备'}))
  choose('经典设备', 'RAT · 对地失真')
  fireEvent.change(screen.getByRole('slider',{name:'Filter · 越大越暗'}),{target:{value:'75'}})
  fireEvent.click(screen.getByRole('button',{name:'旁通',exact:true}))
  fireEvent.click(screen.getByRole('button',{name:/保存\s*未保存/}))
  await waitFor(()=>expect(save).toHaveBeenCalled())
  expect(save.mock.calls.at(-1)?.[0].chain.drive).toMatchObject({enabled:true,device:'rat',tone:.75})
  fireEvent.click(screen.getByRole('button',{name:'效果',exact:true}))
  await waitFor(()=>expect(monitor).toHaveBeenCalled())
  fireEvent.change(screen.getByRole('slider',{name:'Distortion'}),{target:{value:'90'}})
  await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].chain.drive.drive).toBe(.9))
})
it('saves classic preamp, physical cab and modulation settings with a library preset', async () => {
  const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset')
  render(<ArsenalPage onToast={() => undefined} />)
  await screen.findByRole('button',{name:/干净起点/})
  choose('箱头引擎', '白盒 · 前级电路')
  choose('前级电路', '2203 · 英式过载前级')
  fireEvent.change(screen.getByRole('slider',{name:'Bass'}),{target:{value:'.75'}})
  fireEvent.click(screen.getByRole('button',{name:'旁通',exact:true}))
  choose('箱体引擎', '物理模型 · C12N')
  choose('箱体结构', 'C12N · 4×12 密闭')
  fireEvent.change(screen.getByRole('spinbutton',{name:'密闭容积 L 数值'}),{target:{value:'160'}})
  fireEvent.click(screen.getByRole('checkbox',{name:'箱体开启'}))
  fireEvent.click(screen.getByRole('button',{name:/调制 \/ 动态.*BYPASS/}))
  choose('调制与动态设备', 'BBD Flanger · 结构近似')
  fireEvent.click(screen.getByRole('button',{name:'旁通',exact:true}))
  fireEvent.click(screen.getByRole('button',{name:'效果前移'}))
  fireEvent.click(screen.getByRole('button',{name:/保存\s*未保存/}))
  await waitFor(()=>expect(save).toHaveBeenCalled())
  const chain=save.mock.calls.at(-1)![0].chain
  expect(chain.amp).toMatchObject({enabled:true,engine:'classic',classic:{device:'2203-pre',bass:.75}})
  expect(chain.cab).toMatchObject({enabled:true,engine:'physical',physical:{device:'sealed412',volumeLitres:160}})
  expect(chain.mod).toMatchObject({enabled:true,device:'flanger'})
  expect(chain.order.indexOf('mod')).toBeLessThan(chain.order.indexOf('eq'))
})
