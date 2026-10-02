// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WoodshedPage from '../src/renderer/src/pages/WoodshedPage.js'
import { PracticeDetail } from '../src/renderer/src/woodshed/Practice.js'
import { PRACTICE_EXERCISES, exerciseForKnowledge, practiceFrame, practiceScore, practiceTuning } from '../src/renderer/src/woodshed/practice-curriculum.js'
import { LEARNING_SYSTEMS } from '../src/renderer/src/woodshed/knowledge.js'
import type { MusicEvent } from '../src/renderer/src/woodshed/types.js'

vi.mock('../src/renderer/src/audio-engine.js', () => ({ setAudioContextOutputDevice: vi.fn(async () => {}) }))
vi.mock('../src/renderer/src/woodshed/audio.js', () => ({ WoodshedAudio: class { stop() {} destroy() {} setReference() {} setVisualActive() {} async setOutput() {} } }))
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
  it('gives every module one comprehensive exercise covering all of its existing exercises', () => {
    const comprehensive = PRACTICE_EXERCISES.filter(e => e.kind === 'comprehensive')
    expect(comprehensive).toHaveLength(30)
    for (const instrument of ['guitar', 'bass', 'ukulele']) {
      const exercises = PRACTICE_EXERCISES.filter(e => e.instrument === instrument)
      const modules = [...new Set(exercises.map(e => e.module))]
      for (const module of modules) {
        const members = exercises.filter(e => e.module === module)
        const combined = members.filter(e => e.kind === 'comprehensive')
        expect(combined, `${instrument}/${module}`).toHaveLength(1)
        expect(combined[0]!.sourceIds!.sort()).toEqual(members.filter(e => !e.kind).map(e => e.id).sort())
        expect(members.at(-1)).toBe(combined[0])
        for (const variant of combined[0]!.variants) {
          const barLength = Number(variant.meter.split('/')[0])
          expect(variant.beats / barLength).toBeGreaterThanOrEqual(16)
          expect(new Set(variant.events.map(e => e.id)).size).toBe(variant.events.length)
          let nextBar = 1
          for (const stage of variant.stages!) {
            expect(stage.startBar).toBe(nextBar)
            expect(stage.endBar - stage.startBar + 1).toBeGreaterThanOrEqual(4)
            const first = practiceFrame(variant, (stage.startBar - 1) * barLength).event!
            expect(first.beat).toBe((stage.startBar - 1) * barLength)
            nextBar = stage.endBar + 1
          }
          expect(nextBar).toBe(variant.beats / barLength + 1)
          expect(practiceFrame(variant, variant.beats).event).toBe(variant.events[0])
        }
      }
    }
  })
  it('moves four fingers across strings and positions and keeps both ukulele meters separate', () => {
    const variant = exercise('guitar-01-comprehensive').variants[0]!
    expect(variant.beats / 4).toBe(30)
    const notesFor = (name: string) => {
      const stage = variant.stages!.find(s => s.name === name)!
      return variant.events.filter(e => e.beat >= (stage.startBar - 1) * 4 && e.beat < stage.endBar * 4).flatMap(e => e.notes)
    }
    expect(new Set(notesFor('不同弦上的四指顺序').map(n => n.string))).toEqual(new Set([1, 2, 3]))
    expect(notesFor('不同把位的四指顺序').map(n => n.fret)).toEqual([3, 4, 5, 6, 6, 5, 4, 3, 5, 6, 7, 8, 8, 7, 6, 5, 7, 8, 9, 10, 10, 9, 8, 7])
    const cross = notesFor('跨弦与换把协调')
    expect(new Set(cross.map(n => n.string))).toEqual(new Set([2, 3]))
    expect(new Set(cross.filter(n => n.string === 3).map(n => n.fret))).toEqual(new Set([3, 5, 7, 9]))
    const waltz = exercise('ukulele-05-comprehensive').variants
    expect(waltz.map(v => v.meter)).toEqual(['4/4', '3/4'])
    expect(waltz[1]!.beats / 3).toBe(16)
    expect(waltz[1]!.events.some(e => e.duration === 3)).toBe(true)
  })
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
  it('opens the module comprehensive card and follows stage boundaries while playing', async () => {
    render(<WoodshedPage onToast={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '专项练习', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '吉他', exact: true }))
    const module = screen.getByRole('region', { name: '01 左手机能与动作效率' })
    expect(within(module).getAllByRole('button')).toHaveLength(4)
    fireEvent.click(within(module).getByRole('button', { name: /版块综合练习/ }))
    expect(screen.getByRole('heading', { name: '综合练习 · 放松、换弦与换把综合练习' })).toBeTruthy()
    expect(document.querySelector('.ws-practice-current-stage')!.textContent).toContain('起始阶段 · 1–4 小节')
    fireEvent.change(screen.getByLabelText('节拍器速度'), { target: { value: '240' } })
    await start(); await tick(4100)
    expect(document.querySelector('.ws-practice-current-stage')!.textContent).toContain('当前阶段 · 5–10 小节')
    expect(document.querySelector('.ws-practice-current-stage')!.textContent).toContain('不同弦上的四指顺序')
    fireEvent.click(screen.getByRole('button', { name: '停止', exact: true }))
    expect(document.querySelector('.ws-practice-current-stage')!.textContent).toContain('起始阶段')
  })
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
