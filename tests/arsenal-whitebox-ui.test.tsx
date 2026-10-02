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
it('saves independent repeated modules, wheel edits, ordering and renamed presets', async () => {
  const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset')
  render(<ArsenalPage onToast={() => undefined} />)
  await screen.findByRole('button',{name:/干净起点/})
  fireEvent.click(screen.getByRole('button',{name:'新建预设'}))
  fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}))
  fireEvent.change(screen.getByRole('combobox',{name:'单块型号'}),{target:{value:'ds1'}})
  fireEvent.wheel(screen.getByRole('slider',{name:'Drive'}),{deltaY:-100})
  expect(screen.getByRole('slider',{name:'Drive'}).getAttribute('aria-valuenow')).toBe('0.41')
  fireEvent.click(screen.getByRole('button',{name:'Drive',exact:true}))
  fireEvent.change(screen.getByRole('combobox',{name:'单块型号'}),{target:{value:'sd1'}})
  fireEvent.click(screen.getByRole('button',{name:'模块前移'}))
  fireEvent.change(screen.getByRole('textbox',{name:'预设名称'}),{target:{value:'双过载'}})
  fireEvent.click(screen.getByRole('button',{name:'保存预设'}))
  await waitFor(()=>expect(save).toHaveBeenCalled())
  const preset=save.mock.calls.at(-1)![0]
  expect(preset.name).toBe('双过载')
  expect(preset.chain.modules?.map(m=>m.settings.drive.device)).toEqual(['sd1','ds1'])
  expect(new Set(preset.chain.modules?.map(m=>m.id)).size).toBe(2)
  expect(preset.chain.modules?.[1]?.settings.drive.drive).toBe(.41)
  expect(screen.queryByText(/输入标定|过采样/)).toBeNull()
})
it('keeps AMP and CAB independent and stops owned monitoring on leaving', async () => {
  const save=vi.spyOn(window.bandbuddy.arsenal,'savePreset')
  const monitor=vi.spyOn(window.bandbuddy.arsenal,'monitor')
  const view=render(<ArsenalPage onToast={() => undefined} />)
  await screen.findByRole('button',{name:/干净起点/})
  fireEvent.click(screen.getByRole('button',{name:'新建预设'}))
  fireEvent.click(screen.getByRole('button',{name:'AMP',exact:true}))
  fireEvent.change(screen.getByRole('combobox',{name:'箱头型号'}),{target:{value:'2203-pre'}})
  fireEvent.click(screen.getByRole('button',{name:'CAB',exact:true}))
  fireEvent.change(screen.getByRole('combobox',{name:'箱体型号'}),{target:{value:'sealed412'}})
  fireEvent.click(screen.getByRole('button',{name:'保存预设'}))
  await waitFor(()=>expect(save).toHaveBeenCalled())
  expect(save.mock.calls.at(-1)![0].chain.modules?.map(m=>m.type)).toEqual(['amp','cab'])
  fireEvent.click(screen.getByRole('button',{name:'效果',exact:true}))
  await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].mode).toBe('wet'))
  view.unmount()
  await waitFor(()=>expect(monitor.mock.calls.at(-1)?.[0].mode).toBe('off'))
})
