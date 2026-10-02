// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FretboardLab } from '../src/renderer/src/woodshed/FretboardLab.js'
import { LAB_TUNINGS } from '../src/renderer/src/woodshed/lab-model.js'

beforeEach(() => localStorage.clear())
afterEach(cleanup)
const setup = () =>
  render(
    <FretboardLab initialTuning={LAB_TUNINGS[0]!} audio={null} a4={440} onBack={vi.fn()} onError={vi.fn()} />
  )
const choose = (label: string, option: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }))
}
describe('fretboard laboratory answer flow', () => {
  it('hides answers, rejects mistakes, completes all C positions and ignores repeat clicks', () => {
    setup()
    fireEvent.click(
      within(screen.getByRole('group', { name: '音名筛选' })).getByRole('button', { name: '单个音' })
    )
    fireEvent.click(screen.getByRole('button', { name: '开始训练' }))
    expect(screen.getByText('找到所有 C')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '5弦 3品 C3' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '6弦 0品', exact: true }))
    expect(screen.getByRole('status').textContent).toContain('还不对')
    fireEvent.click(screen.getByRole('button', { name: '5弦 3品', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '5弦 3品', exact: true }))
    expect(screen.getByText('进度 1 / 6')).toBeTruthy()
    for (const name of ['1弦 8品', '2弦 1品', '3弦 5品', '4弦 10品', '6弦 8品'])
      fireEvent.click(screen.getByRole('button', { name, exact: true }))
    expect(screen.getByText('进度 6 / 6')).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一题' })).toBeTruthy()
    const progress = JSON.parse(localStorage.getItem('bandbuddy.fretboard-progress.v1')!)
    expect(progress.modules.notes).toEqual({ correct: 6, wrong: 1 })
  })
  it('does not mark hinted answers as learned', () => {
    setup()
    fireEvent.click(
      within(screen.getByRole('group', { name: '音名筛选' })).getByRole('button', { name: '单个音' })
    )
    fireEvent.click(screen.getByRole('button', { name: '开始训练' }))
    fireEvent.click(screen.getByRole('button', { name: '提示', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '5弦 3品', exact: true }))
    const progress = JSON.parse(localStorage.getItem('bandbuddy.fretboard-progress.v1')!)
    expect(progress.modules.notes.correct).toBe(0)
    expect(screen.getByText('进度 1 / 6')).toBeTruthy()
  })
  it('supports seventh-string notes and restores saved tuning', () => {
    setup()
    choose('指板乐器', '七弦吉他')
    expect(screen.getByRole('button', { name: '7弦 0品 B1' })).toBeTruthy()
    cleanup()
    setup()
    expect(screen.getByRole('combobox', { name: '指板乐器' }).textContent).toContain('七弦吉他')
    expect(screen.queryByText('持续参考音')).toBeNull()
    expect(screen.queryByText('练习工作台')).toBeNull()
  })
  it('shows actual triads and changes the selected inversion', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: '和弦 Chords' }))
    fireEvent.click(screen.getByRole('button', { name: '三和弦转位' }))
    expect(document.querySelectorAll('.fl-marker')).toHaveLength(3)
    const before = [...document.querySelectorAll('.fl-cell:has(.fl-marker)')].map((n) =>
      n.getAttribute('aria-label')
    )
    fireEvent.click(screen.getByRole('button', { name: '下一个把位' }))
    const after = [...document.querySelectorAll('.fl-cell:has(.fl-marker)')].map((n) =>
      n.getAttribute('aria-label')
    )
    expect(after).not.toEqual(before)
  })
  it('sets octave training to actual octave pitches rather than every pitch-class match', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '训练模式' }))
    choose('训练阶段', '5. 同音与八度位置')
    fireEvent.click(screen.getByRole('button', { name: '开始训练' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('的八度')
    expect(document.querySelectorAll('.fl-marker.root')).toHaveLength(1)
  })
  it('moves through ii V I using the current chord root on every new question', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '训练模式' }))
    choose('训练阶段', '13. 和弦进行 · ii–V–I')
    fireEvent.click(screen.getByRole('button', { name: '开始训练' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('D 小七和弦')
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('G 属七和弦')
    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('C 大七和弦')
  })
  it('lets the degree filter select b3 even when the current key is major', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: '音级 Degrees' }))
    fireEvent.click(screen.getByRole('button', { name: '♭3', exact: true }))
    const markers = [...document.querySelectorAll('.fl-marker')]
    expect(markers.length).toBeGreaterThan(0)
    expect(markers.every((marker) => marker.textContent === '♭3')).toBe(true)
  })
  it('recovers from a corrupt saved focus range and progress record', () => {
    localStorage.setItem(
      'bandbuddy.fretboard-settings.v1',
      JSON.stringify({ tuningId: 'uke-high', min: 17, max: 2 })
    )
    localStorage.setItem('bandbuddy.fretboard-progress.v1', '{broken')
    setup()
    expect(screen.getByRole('button', { name: '1弦 17品 D6' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始训练' })).toBeTruthy()
  })
})
