// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WoodshedPage from '../src/renderer/src/pages/WoodshedPage.js'
import { PracticeDetail } from '../src/renderer/src/woodshed/Practice.js'
import { PRACTICE_EXERCISES, exerciseForKnowledge, practiceFrame, practiceScore, practiceTuning } from '../src/renderer/src/woodshed/practice-curriculum.js'
import { LEARNING_SYSTEMS } from '../src/renderer/src/woodshed/knowledge.js'
import type { MusicEvent } from '../src/renderer/src/woodshed/types.js'

vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
vi.mock('../src/renderer/src/woodshed/audio.js', () => ({ WoodshedAudio: class { stop() {} destroy() {} setReference() {} async setOutput() {} } }))
// VexFlow itself is verified in the real browser. This test exercises audio scheduling and the React lifecycle.
vi.mock('../src/renderer/src/woodshed/Score.js', () => ({ Score: ({ events }: { events: MusicEvent[] }) => <div aria-label="练习谱例">{events.map(e => <span key={e.id} data-event={e.id}>{e.notes.map(n => `${n.string}:${n.fret}`).join('+') || '休止'}</span>)}</div> }))
class Param {
  value = 0
  setValueAtTime(value: number) { this.value = value }
  setTargetAtTime(value: number) { this.value = value }
  exponentialRampToValueAtTime() {} linearRampToValueAtTime() {}
}
const sounds: Source[] = []
class Source {
  frequency = new Param()
  type = ''
  connect() {} disconnect() {}
  start = vi.fn()
  stop = vi.fn()
  onended: (() => void) | null = null
}
class Context {
  destination = {}
  get currentTime() { return Date.now() / 1000 }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain() { return { gain: new Param(), connect() {} } }
  createOscillator() { const s = new Source(); sounds.push(s); return s }
}
beforeEach(() => {
  localStorage.clear(); sounds.length = 0
  vi.useFakeTimers(); vi.setSystemTime(0)
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  Element.prototype.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const exercise = (id: string) => PRACTICE_EXERCISES.find(e => e.id === id)!
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function start() { await act(async () => fireEvent.click(screen.getByRole('button', { name: '开始', exact: true }))) }
const active = () => [...document.querySelectorAll('[data-active=true]')].map(n => n.getAttribute('data-position'))

describe('authored practice material', () => {
  it('covers eighteen guitar modules with playable, complete scores and valid knowledge links', () => {
    expect(new Set(PRACTICE_EXERCISES.filter(e => e.instrument === 'guitar').map(e => e.module)).size).toBe(18)
    expect(new Set(PRACTICE_EXERCISES.map(e => e.id)).size).toBe(PRACTICE_EXERCISES.length)
    const knowledge = new Set(LEARNING_SYSTEMS.flatMap(s => s.stages.flatMap(g => g.nodes.map(n => n.id))))
    for (const e of PRACTICE_EXERCISES) {
      for (const k of e.knowledge) expect(knowledge.has(k), k).toBe(true)
      const tuning = practiceTuning(e.instrument)
      for (const v of e.variants) {
        expect(v.beats % Number(v.meter.split('/')[0])).toBe(0)
        let cursor = 0
        for (const event of v.events) {
          expect(event.beat).toBeCloseTo(cursor, 8)
          for (const note of event.notes) expect(note.midi).toBe(tuning.notes[tuning.notes.length - note.string]! + note.fret)
          cursor += event.duration
        }
        expect(cursor).toBeCloseTo(v.beats, 8)
      }
    }
  })
  it('provides complete reading-to-practice paths for both instruments and the foundational systems', () => {
    for (const id of ['bass', 'ukulele', 'shared', 'blues']) {
      const system = LEARNING_SYSTEMS.find(s => s.id === id)!
      if (id === 'bass' || id === 'ukulele') {
        expect(system.stages).toHaveLength(6)
        expect(system.stages.flatMap(s => s.nodes)).toHaveLength(24)
        expect(new Set(PRACTICE_EXERCISES.filter(e => e.instrument === id).map(e => e.module)).size).toBe(6)
      }
      for (const node of system.stages.flatMap(s => s.nodes)) {
        const target = exerciseForKnowledge(node.id)
        expect(target, node.id).toBeDefined()
        expect(target!.instrument).toBe(id === 'bass' || id === 'ukulele' ? id : 'guitar')
      }
    }
  })
  it('keeps high G pitch order and chord names correct rather than copying bass string order', () => {
    const opens = exercise('ukulele-tuning').variants[0]!.events.map(e => e.notes[0]!.midi)
    expect(opens).toEqual([67, 60, 64, 69])
    const chord = exercise('ukulele-change').variants[0]!.events[0]!.notes.map(n => n.midi)
    expect(chord).toEqual([69, 60, 65, 69]) // F/C, not a root-position F.
    expect(exercise('bass-open-strings').variants[0]!.events.map(e => e.notes[0]!.midi)).toEqual([28, 33, 38, 43])
  })
  it('uses a three-beat loop and exact triplet offsets, and rejects malformed scores', () => {
    const waltz = exercise('ukulele-waltz').variants[0]!
    expect(practiceFrame(waltz, 2.99).bar).toBe(1)
    expect(practiceFrame(waltz, 3).bar).toBe(2)
    expect(practiceFrame(waltz, 6).event).toBe(waltz.events[0])
    const shuffle = exercise('guitar-shuffle').variants[1]!
    expect(shuffle.events[0]!.duration).toBeCloseTo(2 / 3)
    expect(practiceFrame(shuffle, 0.65).event).toBe(shuffle.events[0])
    expect(practiceFrame(shuffle, 0.67).event).toBe(shuffle.events[1])
    expect(practiceFrame(shuffle, 1).event).toBe(shuffle.events[2])
    expect(() => practiceScore('bass', '5:0/4')).toThrow()
    expect(() => practiceScore('ukulele', '1:nope/4')).toThrow()
    expect(() => practiceScore('ukulele', '1:0/4', '3/4')).toThrow()
    expect(() => practiceScore('guitar', '1:0/0.2')).toThrow()
  })
  it('holds sustained notes, distinguishes rests and wraps precisely at loop boundaries', () => {
    const chord = exercise('guitar-chord-change').variants[0]!
    expect(practiceFrame(chord, 3.9).event).toBe(chord.events[0])
    expect(practiceFrame(chord, 4).event).toBe(chord.events[1])
    expect(practiceFrame(chord, 8).event).toBe(chord.events[0])
    const rest = exercise('guitar-offbeat').variants[1]!
    expect(practiceFrame(rest, 0.49).event?.notes).toHaveLength(0)
    expect(practiceFrame(rest, 0.5).event?.notes).toHaveLength(1)
  })
})

describe('practice transport and navigation', () => {
  it('resets the visual beat on three, and keeps the fourth string high on ukulele', async () => {
    render(<PracticeDetail exercise={exercise('ukulele-waltz')} outputDeviceId="" onError={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('节拍器速度'), { target: { value: '120' } })
    expect(document.querySelectorAll('.ws-practice-beats i')).toHaveLength(3)
    await start(); await tick(100)
    expect(active()).toEqual(expect.arrayContaining(['4:0', '3:0', '2:0', '1:3']))
    await tick(1000)
    expect(screen.getByLabelText('第 1 小节，第 3 拍')).toBeTruthy()
    await tick(500)
    expect(screen.getByLabelText('第 2 小节，第 1 拍')).toBeTruthy()
    expect(active()).toEqual(expect.arrayContaining(['4:2', '3:0', '2:0', '1:0']))
  })
  it('navigates from an instrument article to its own fixed-tuning exercise', () => {
    render(<WoodshedPage onToast={vi.fn()} />)
    for (const [instrument, node, target] of [['贝斯', 'Slap、Pop 与制音分工', 'Slap 与 Pop 八度问答'], ['尤克里里', '三拍子与复合拍', '三拍子 C–Am 伴奏']]) {
      fireEvent.click(screen.getByRole('button', { name: instrument, exact: true }))
      fireEvent.click(screen.getByRole('button', { name: node, exact: true }))
      expect(screen.queryByLabelText('节拍器速度')).toBeNull()
      expect(screen.queryByText('练习工作台')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '练习', exact: true }))
      expect(screen.getByRole('heading', { name: target, exact: true })).toBeTruthy()
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain('4弦练习指板')
      expect(document.querySelector('details')!.open).toBe(false)
      fireEvent.click(within(screen.getByRole('navigation', { name: '页面路径' })).getByRole('button', { name: '练功房', exact: true }))
    }
  })
  it('starts clicks, highlights and timer together; stop clears highlight and freezes time', async () => {
    render(<PracticeDetail exercise={exercise('guitar-four-fingers')} outputDeviceId="" onError={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('节拍器速度'), { target: { value: '120' } })
    expect(screen.getByLabelText('练习计时').textContent).toBe('00:00')
    expect(active()).toEqual([])
    await start(); await tick(100)
    expect(active()).toEqual(['1:5'])
    await tick(500)
    expect(active()).toEqual(['1:6'])
    await tick(1000)
    expect(screen.getByLabelText('练习计时').textContent).toBe('00:01')
    expect(sounds[1]!.start.mock.calls[0]![0] - sounds[0]!.start.mock.calls[0]![0]).toBeCloseTo(0.5)
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(active()).toEqual([])
    const count = sounds.length
    await tick(2000)
    expect(sounds.length).toBe(count)
    expect(screen.getByLabelText('练习计时').textContent).toBe('00:01')
    await start(); await tick(100)
    expect(screen.getByLabelText('练习计时').textContent).toBe('00:00')
    expect(active()).toEqual(['1:5'])
  })
  it('clears the fretboard during a rest, and changes variants only while stopped', async () => {
    render(<PracticeDetail exercise={exercise('guitar-offbeat')} outputDeviceId="" onError={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('节拍器速度'), { target: { value: '120' } })
    await start(); await tick(100)
    expect(active()).toEqual(['1:5'])
    expect((screen.getByRole('button', { name: '后半拍' }) as HTMLButtonElement).disabled).toBe(true)
    await tick(500)
    expect(active()).toEqual([])
    expect(screen.getByText('休止', { selector: 'figcaption' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    fireEvent.click(screen.getByRole('button', { name: '后半拍' }))
    await start(); await tick(100)
    expect(active()).toEqual([])
    await tick(250)
    expect(active()).toEqual(['1:5'])
  })
  it('keeps all chord positions highlighted across metronome beats', async () => {
    render(<PracticeDetail exercise={exercise('guitar-chord-change')} outputDeviceId="" onError={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('节拍器速度'), { target: { value: '120' } })
    await start(); await tick(1100)
    expect(active()).toHaveLength(6)
    await tick(1000)
    expect(active()).toHaveLength(5)
    expect(active()).not.toContain('6:0')
  })
  it('cancels a pending start on unmount without scheduling late sound', async () => {
    let resume!: () => void
    class DelayedContext extends Context { override resume = vi.fn(() => new Promise<void>(resolve => { resume = resolve })) }
    vi.stubGlobal('AudioContext', DelayedContext)
    const view = render(<PracticeDetail exercise={exercise('bass-roots')} outputDeviceId="" onError={vi.fn()} />)
    await start()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    view.unmount()
    await act(async () => resume())
    await tick(2000)
    expect(sounds).toHaveLength(0)
  })
  it('reports audio initialization failure without starting the timer', async () => {
    class FailedContext extends Context { override resume = vi.fn(async () => { throw new Error('output unavailable') }) }
    vi.stubGlobal('AudioContext', FailedContext)
    const onError = vi.fn()
    render(<PracticeDetail exercise={exercise('bass-roots')} outputDeviceId="" onError={onError} />)
    await start(); await tick(2000)
    expect(screen.getByRole('alert').textContent).toContain('output unavailable')
    expect(screen.getByRole('button', { name: '开始' })).toBeTruthy()
    expect(screen.getByLabelText('练习计时').textContent).toBe('00:00')
    expect(active()).toEqual([])
    expect(onError).toHaveBeenCalledOnce()
  })
  it('opens linked guitar practice, supports three breadcrumb levels, and stops on navigation', async () => {
    render(<WoodshedPage onToast={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '吉他', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '单音与双手协调' }))
    fireEvent.click(screen.getByRole('button', { name: '练习', exact: true }))
    expect(screen.getByRole('heading', { name: '单弦四指顺序' })).toBeTruthy()
    expect(screen.queryByLabelText('乐器与调弦')).toBeNull()
    expect(document.querySelector('details')?.open).toBe(false)
    fireEvent.click(screen.getByText('练习讲解与里程碑'))
    expect(document.querySelector('details')?.open).toBe(true)
    await start(); await tick(100)
    const path = within(screen.getByRole('navigation', { name: '页面路径' }))
    fireEvent.click(path.getByRole('button', { name: '吉他', exact: true }))
    const count = sounds.length
    await tick(2000)
    expect(sounds.length).toBe(count)
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
    fireEvent.click(path.getByRole('button', { name: '专项练习' }))
    fireEvent.click(screen.getByRole('button', { name: '贝斯', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '低音音长与休止' }))
    expect(screen.getByRole('heading', { name: '低音音长与休止' })).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('4弦')
  })
})
