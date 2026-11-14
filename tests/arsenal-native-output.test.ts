// @vitest-environment jsdom
/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { arsenalDestination } from '../src/renderer/src/arsenal/native-output.js'
import { nativeOutputRoutes, prepareNativeOutput, restoreBrowserOutput } from '../src/renderer/src/arsenal/output-coordinator.js'
import { resetArsenalWorkspace, setMonitor, useArsenal } from '../src/renderer/src/arsenal/workspace-store.js'

const contexts: Array<EventTarget & { state: string }> = []
function audioContext(addModule = vi.fn().mockResolvedValue(undefined)) {
  const context = Object.assign(new EventTarget(), {
    state: 'suspended', currentTime: 0, sampleRate: 48000, sinkId: 'usb-output',
    destination: {}, audioWorklet: { addModule }, setSinkId: vi.fn().mockResolvedValue(undefined),
    createGain: () => {
      const node = { gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }
      node.connect.mockImplementation(target => target)
      return node
    }
  })
  contexts.push(context)
  return context
}
const idle = { active: false, mode: 'off', redirectBrowserOutput: true }
let listeners: Set<(state: typeof idle) => void>
let worklet: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetArsenalWorkspace()
  listeners = new Set()
  worklet = vi.fn(function () {
    return { port: { postMessage: vi.fn() }, connect: vi.fn(target => target), disconnect: vi.fn() }
  })
  vi.stubGlobal('AudioWorkletNode', worklet)
  Object.defineProperty(window, 'bandbuddy', { configurable: true, value: { arsenal: {
    feed: vi.fn().mockResolvedValue(true), monitor: vi.fn().mockResolvedValue(idle),
    monitorState: vi.fn().mockResolvedValue(idle),
    onMonitor: vi.fn(callback => { listeners.add(callback); return () => listeners.delete(callback) })
  } } })
})
afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.state = 'closed'
    context.dispatchEvent(new Event('statechange'))
  }
  resetArsenalWorkspace()
  vi.unstubAllGlobals()
})

describe('Arsenal native output preparation', () => {
  it('waits for worklet loading before handing the browser sink to native monitoring', async () => {
    let loaded!: () => void
    const context = audioContext(vi.fn(() => new Promise<void>(resolve => { loaded = resolve })))
    const input = arsenalDestination(context as unknown as AudioContext)
    expect(arsenalDestination(context as unknown as AudioContext)).toBe(input)
    const prepare = prepareNativeOutput()
    expect(context.setSinkId).not.toHaveBeenCalled()
    loaded()
    await prepare
    expect(worklet).toHaveBeenCalledWith(context, 'bandbuddy-arsenal-output', expect.any(Object))
    expect(context.setSinkId).toHaveBeenCalledWith({ type: 'none' })
    await restoreBrowserOutput()
    expect(context.setSinkId).toHaveBeenLastCalledWith('usb-output')
  })

  it('keeps the loading failure visible and does not try to start native monitoring', async () => {
    const context = audioContext(vi.fn().mockRejectedValue(new DOMException('Blocked by script-src', 'AbortError')))
    arsenalDestination(context as unknown as AudioContext)
    await setMonitor('wet')
    expect(useArsenal.getState().error).toContain('无法启动统一音频输出：AbortError: Blocked by script-src')
    expect(useArsenal.getState().busy).toBe(false)
    expect(window.bandbuddy.arsenal.monitor).not.toHaveBeenCalled()
    expect(context.setSinkId).not.toHaveBeenCalled()
  })

  it('releases a context closed during worklet loading without blocking other monitor starts', async () => {
    let loaded!: () => void
    const context = audioContext(vi.fn(() => new Promise<void>(resolve => { loaded = resolve })))
    arsenalDestination(context as unknown as AudioContext)
    const prepare = prepareNativeOutput()
    context.state = 'closed'
    context.dispatchEvent(new Event('statechange'))
    loaded()
    await expect(prepare).resolves.toBeUndefined()
    expect(worklet).not.toHaveBeenCalled()
    expect(context.setSinkId).not.toHaveBeenCalled()
    expect(nativeOutputRoutes.size).toBe(0)
  })

  it.each(['auto', 'wasapi-shared', 'coreaudio'])('keeps %s accompaniment on one unchanged browser path when monitoring toggles', async backend => {
    Object.assign(window.bandbuddy, { settings: { get: vi.fn(async () => ({ recordingAudio: { backend } })) } })
    const context = audioContext(), input = arsenalDestination(context as unknown as AudioContext)
    await prepareNativeOutput()
    for (const callback of listeners) callback({ active: true, mode: 'dry', redirectBrowserOutput: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(arsenalDestination(context as unknown as AudioContext)).toBe(input)
    for (const callback of listeners) callback({ active: false, mode: 'off', redirectBrowserOutput: false })
    await restoreBrowserOutput()
    expect(context.setSinkId).not.toHaveBeenCalled()
    expect(context.audioWorklet.addModule).not.toHaveBeenCalled()
    expect(worklet).not.toHaveBeenCalled()
    expect(window.bandbuddy.arsenal.feed).not.toHaveBeenCalled()
  })

  it('disconnects the browser copy before native handoff and waits for the native reset before reconnecting', async () => {
    const context = audioContext(), nodes: ReturnType<typeof context.createGain>[] = []
    const createGain = context.createGain
    context.createGain = () => { const node = createGain(); nodes.push(node); return node }
    arsenalDestination(context as unknown as AudioContext)
    const local = nodes[1]!
    await prepareNativeOutput()
    expect(local.disconnect).toHaveBeenCalledOnce()
    expect(local.disconnect.mock.invocationCallOrder[0]).toBeLessThan(context.setSinkId.mock.invocationCallOrder[0]!)
    for (const callback of listeners) callback({ active: true, mode: 'dry', redirectBrowserOutput: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    let finishReset!: (ok: boolean) => void
    vi.mocked(window.bandbuddy.arsenal.feed).mockImplementationOnce(() => new Promise(resolve => { finishReset = resolve }))
    const restore = restoreBrowserOutput()
    await vi.waitFor(() => expect(finishReset).toBeTypeOf('function'))
    expect(local.connect).toHaveBeenCalledTimes(1)
    finishReset(true)
    await restore
    expect(local.connect).toHaveBeenCalledTimes(2)
    expect(context.setSinkId).toHaveBeenLastCalledWith('usb-output')
  })
})
