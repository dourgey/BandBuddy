// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArsenalPage } from '../src/renderer/src/pages/ArsenalPage.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'
import { resetArsenalWorkspace, useArsenal } from '../src/renderer/src/arsenal/workspace-store.js'
import type { ToneAsset } from '../packages/shared/src/arsenal.js'
import { MODELED_AMPS, MODELED_CABS } from '../packages/shared/src/amp-cab-catalog.js'
import { bundledIrCatalogSchema } from '../packages/shared/src/cabinet-ir-library.js'
import bundledCatalog from '../resources/cabinet-irs/manifest.json'

beforeEach(() => {
  resetArsenalWorkspace(); localStorage.clear()
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge(); Element.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block' }
})
afterEach(() => { cleanup(); resetArsenalWorkspace(); vi.restoreAllMocks() })
const choose = (label: string, option: string): void => {
  fireEvent.click(screen.getByRole('combobox', { name: label })); fireEvent.click(screen.getByRole('option', { name: option, exact: true }))
}
async function ready(): Promise<void> {
  render(<ArsenalPage onToast={() => undefined}/>); await waitFor(() => expect(useArsenal.getState().ready).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: '新建预设' }))
}
it('offers named heads with the controls belonging to each topology', async () => {
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'AMP', exact: true }))
  choose('箱头型号', MODELED_AMPS.find(a => a.id === 'vox-ac30')!.name)
  expect(screen.getByRole('slider', { name: 'CUT' })).toBeTruthy()
  expect(screen.getByRole('slider', { name: 'LEVEL' })).toBeTruthy()
  expect(screen.queryByRole('slider', { name: 'MASTER' })).toBeNull()
  expect(screen.queryByRole('slider', { name: 'MIDDLE' })).toBeNull()
  expect(screen.queryByRole('slider', { name: 'PRESENCE' })).toBeNull()
  choose('箱头型号', MODELED_AMPS.find(a => a.id === 'mesa-rectifier')!.name)
  expect(screen.getByRole('slider', { name: 'MIDDLE' })).toBeTruthy()
  expect(screen.getByRole('slider', { name: 'PRESENCE' })).toBeTruthy()
  expect(screen.getByRole('slider', { name: 'MASTER' })).toBeTruthy()
  expect(screen.queryByRole('slider', { name: 'CUT' })).toBeNull()
})
it('imports in the cabinet panel, selects immediately, filters only IR and retains selection across type changes', async () => {
  const a: ToneAsset = { id: 'a'.repeat(64), kind: 'ir', name: 'Greenback center', sampleRate: 44100, channels: 2, durationMs: 200, metadata: {}, createdAt: '' }
  const b: ToneAsset = { ...a, id: 'b'.repeat(64), name: 'V30 edge' }
  const list = vi.spyOn(window.bandbuddy.arsenal, 'list').mockResolvedValue({ presets: [], assets: [{ ...a, id: 'c'.repeat(64), kind: 'nam', name: 'NAM only' }] })
  vi.spyOn(window.bandbuddy.arsenal, 'importAsset').mockImplementation(async () => {
    list.mockResolvedValue({ presets: [], assets: [a, b, { ...a, id: 'c'.repeat(64), kind: 'nam', name: 'NAM only' }] }); return a
  })
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'CAB', exact: true })); choose('箱体型号', 'IR · 箱体响应')
  const panel = within(screen.getByRole('region', { name: '箱体 IR 列表' }))
  expect(panel.queryByText('NAM only')).toBeNull()
  fireEvent.click(panel.getByRole('button', { name: '导入 IR' }))
  await waitFor(() => expect(useArsenal.getState().draft.chain.modules?.[0]?.settings.cab.assetId).toBe(a.id))
  expect(panel.getByRole('button', { name: /Greenback center/ }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.change(panel.getByRole('textbox', { name: '搜索 IR' }), { target: { value: 'v30' } })
  expect(panel.queryByRole('button', { name: /Greenback center/ })).toBeNull()
  fireEvent.click(panel.getByRole('button', { name: /V30 edge/ }))
  expect(useArsenal.getState().draft.chain.modules?.[0]?.settings.cab.assetId).toBe(b.id)
  choose('箱体型号', MODELED_CABS.find(a => a.id === 'marshall-1960ax')!.name)
  expect(screen.queryByRole('region', { name: '箱体 IR 列表' })).toBeNull()
  expect(useArsenal.getState().draft.chain.modules?.[0]?.settings.cab.physical.volumeLitres).toBe(170)
  choose('箱体型号', 'IR · 箱体响应')
  expect(useArsenal.getState().draft.chain.modules?.[0]?.settings.cab.assetId).toBe(b.id)
  const save = vi.spyOn(window.bandbuddy.arsenal, 'savePreset')
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }))
  await waitFor(() => expect(save).toHaveBeenCalled())
  expect(save.mock.calls[0]![0].chain.modules?.[0]?.settings.cab.assetId).toBe(b.id)
})
it('cancel and failed imports preserve the selected IR, and an async import cannot overwrite a deleted module', async () => {
  const importer = vi.spyOn(window.bandbuddy.arsenal, 'importAsset').mockResolvedValue(null)
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'CAB', exact: true })); choose('箱体型号', 'IR · 箱体响应')
  const panel = within(screen.getByRole('region', { name: '箱体 IR 列表' }))
  fireEvent.click(panel.getByRole('button', { name: '导入 IR' }))
  await waitFor(() => expect((panel.getByRole('button', { name: '导入 IR' }) as HTMLButtonElement).disabled).toBe(false))
  expect(useArsenal.getState().draft.chain.modules?.[0]?.settings.cab.assetId).toBeNull()
  importer.mockRejectedValueOnce(new Error('损坏的 WAV'))
  fireEvent.click(panel.getByRole('button', { name: '导入 IR' })); expect(await panel.findByRole('alert')).toHaveProperty('textContent', '损坏的 WAV')
  let resolve!: (value: ToneAsset) => void
  importer.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  fireEvent.click(panel.getByRole('button', { name: '导入 IR' })); fireEvent.click(screen.getByRole('button', { name: '删除模块' }))
  await act(async () => resolve({ id: 'a'.repeat(64), kind: 'ir', name: 'New', sampleRate: 48000, channels: 1, durationMs: 20, metadata: {}, createdAt: '' }))
  expect(useArsenal.getState().draft.chain.modules).toEqual([])
})

it('uses bundled IRs without importing, filters by source, and exposes attribution without a delete action', async () => {
  const builtins = bundledIrCatalogSchema.parse(bundledCatalog).assets
  const first = builtins[0]!, user: ToneAsset = { ...first, id: 'f'.repeat(64), bundled: false, attribution: undefined, name: '我的 IR' }
  vi.spyOn(window.bandbuddy.arsenal, 'list').mockResolvedValue({ presets: [], assets: [...builtins, user] })
  const importer = vi.spyOn(window.bandbuddy.arsenal, 'importAsset')
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'CAB', exact: true })); choose('箱体型号', 'IR · 箱体响应')
  const panel = within(screen.getByRole('region', { name: '箱体 IR 列表' }))
  choose('IR 来源', '内置')
  expect(panel.queryByRole('button', { name: /我的 IR/ })).toBeNull()
  fireEvent.change(panel.getByRole('textbox', { name: '搜索 IR' }), { target: { value: 'Greenback' } })
  expect(panel.getAllByRole('button', { name: /Marshall 1960AX/ })).toHaveLength(6)
  fireEvent.click(panel.getByRole('button', { name: new RegExp(first.name) }))
  expect(useArsenal.getState().draft.chain.modules?.[0]?.settings.cab.assetId).toBe(first.id)
  expect(importer).not.toHaveBeenCalled()
  fireEvent.click(panel.getByText(/^来源与授权/))
  expect(panel.getByRole('link', { name: '原始发布' }).getAttribute('href')).toBe(first.attribution.sourceUrl)
  expect(panel.getByRole('link', { name: 'CC0-1.0' }).getAttribute('href')).toBe(first.attribution.licenseUrl)
  const command = vi.spyOn(window.bandbuddy.arsenal, 'command')
  fireEvent.click(panel.getByRole('link', { name: '原始发布' }))
  expect(command).toHaveBeenCalledWith({ action: 'assetLink', id: first.id, link: 'source' })
  fireEvent.change(panel.getByRole('textbox', { name: '搜索 IR' }), { target: { value: '' } })
  choose('IR 来源', '已导入')
  expect(panel.getAllByRole('button', { name: /我的 IR/ })).toHaveLength(1)
  expect(panel.queryByRole('button', { name: /Marshall 1960AX/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '资源', exact: true }))
  fireEvent.click(screen.getAllByRole('button', { name: new RegExp(first.name) }).find(b => b.classList.contains('asset-row'))!)
  expect(screen.queryByRole('button', { name: '删除资源' })).toBeNull()
  expect(screen.getByRole('button', { name: '保存资源信息' })).toBeTruthy()
})
