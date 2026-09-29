// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarmonyExplorer } from '../src/renderer/src/woodshed/HarmonyExplorer.js'
import { diatonicChords, harmonyLabels, keySignature } from '../src/renderer/src/woodshed/harmony.js'
import { SCALES } from '../src/renderer/src/woodshed/theory.js'
const audio = vi.hoisted(() => ({ preview: vi.fn(async () => {}), play: vi.fn(async () => {}), stop: vi.fn(), destroy: vi.fn(), configure: vi.fn(), setOutput: vi.fn(async () => {}) }))
vi.mock('../src/renderer/src/woodshed/harmony-audio.js', () => ({ HarmonyAudio: class { constructor() { return audio } } }))
beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
afterEach(cleanup)
function Harness() { const [root,onRoot] = useState(0); return <HarmonyExplorer root={root} onRoot={onRoot} outputDeviceId="" a4={440} onError={vi.fn()} /> }
describe('harmony theory', () => {
  it('spells sharp and flat keys, including E sharp in F sharp major', () => {
    expect([...harmonyLabels(6,SCALES.major!).values()].map(n=>n.note)).toEqual(['F#','G#','A#','B','C#','D#','E#'])
    expect(diatonicChords(1,false).map(c=>c.name)).toEqual(['Db','Ebm','Fm','Gb','Ab','Bbm','Cdim'])
    expect(keySignature(9,true)).toBe('0 ♯ · 0 ♭')
  })
  it('derives minor chord qualities and actual degrees', () => {
    expect(diatonicChords(9,true).map(c=>c.name)).toEqual(['Am','Bdim','C','Dm','Em','F','G'])
    expect([...harmonyLabels(9,SCALES['minor-pent']!).values()].map(n=>n.degree)).toEqual(['1','♭3','4','5','♭7'])
  })
})
describe('harmony explorer', () => {
  it('changes key and restores the same key after a temporary chord focus', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button',{name:'G大调',exact:true}))
    expect(screen.getByRole('heading',{name:'G Major'})).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'聚焦 D',exact:true}))
    expect(screen.getByRole('heading',{name:'D',exact:true})).toBeTruthy()
    expect(audio.preview).toHaveBeenCalledWith([50,54,57])
    fireEvent.click(screen.getByRole('button',{name:'聚焦 D',exact:true}))
    expect(screen.getByRole('heading',{name:'G Major'})).toBeTruthy()
  })
  it('preserves tuning and label mode when changing music mode and instrument', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Guitar 调弦'),{target:{value:'drop-d'}})
    fireEvent.click(screen.getByRole('button',{name:'音级 Degree'}))
    fireEvent.click(screen.getByRole('button',{name:'和弦 Chord'}))
    fireEvent.change(screen.getByLabelText('和弦类型'),{target:{value:'maj7'}})
    expect(screen.getByRole('heading',{name:'C maj7'})).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'Bass',exact:true}))
    fireEvent.click(screen.getByRole('button',{name:'Guitar',exact:true}))
    expect((screen.getByLabelText('Guitar 调弦') as HTMLSelectElement).value).toBe('drop-d')
    expect(screen.getByRole('button',{name:'音级 Degree'}).getAttribute('aria-pressed')).toBe('true')
  })
  it('links the same pitch class across both instruments', () => {
    const {container} = render(<Harness />)
    fireEvent.click(screen.getByRole('button',{name:'Piano E4',exact:true}))
    expect(container.querySelectorAll('.he-guitar .he-note.selected').length).toBeGreaterThan(3)
    expect(container.querySelectorAll('.he-piano .selected').length).toBe(3)
    expect(audio.preview).toHaveBeenCalledWith([64])
  })
  it('distinguishes high G and low G by a full octave', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button',{name:'Ukulele',exact:true}))
    fireEvent.click(screen.getByRole('button',{name:'Ukulele 4弦 0品 G4'}))
    expect(audio.preview).toHaveBeenLastCalledWith([67])
    fireEvent.change(screen.getByLabelText('Ukulele 调弦'),{target:{value:'uke-low'}})
    fireEvent.click(screen.getByRole('button',{name:'Ukulele 4弦 0品 G3'}))
    expect(audio.preview).toHaveBeenLastCalledWith([55])
  })
  it('builds an entire progression for the audio clock and stops on mode change', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button',{name:'进行 Progression'}))
    fireEvent.click(screen.getByRole('button',{name:'Loop',exact:true}))
    fireEvent.click(screen.getByRole('button',{name:'播放和声'}))
    expect(audio.play.mock.calls[0]?.[0]).toEqual([{notes:[48,52,55],beats:4},{notes:[55,59,62],beats:4},{notes:[57,60,64],beats:4},{notes:[53,57,60],beats:4}])
    expect(audio.play.mock.calls[0]?.[2]).toBe(true)
    fireEvent.click(screen.getByRole('button',{name:'音阶 Scale'}))
    expect(screen.getByRole('button',{name:'播放和声'})).toBeTruthy()
  })
  it('supports minor ring selection and note details without changing key', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button',{name:'Am小调',exact:true}))
    expect(screen.getByRole('heading',{name:'A Minor'})).toBeTruthy()
    fireEvent.contextMenu(screen.getByRole('button',{name:'Piano C4',exact:true}))
    expect(within(screen.getByRole('dialog',{name:'音位详情'})).getByText(/A Minor/)).toBeTruthy()
  })
})
