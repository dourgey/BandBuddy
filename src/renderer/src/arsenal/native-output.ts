import { nativeOutputRoutes } from './output-coordinator.js'
import { defaultEffectChain, type ArsenalApi } from '@shared/arsenal.js'
import outputWorkletUrl from './native-output.worklet.js?url&no-inline'

const reportOutputError = (error: string): void => { window.dispatchEvent(new CustomEvent('arsenal-output-error', { detail: error })) }
const routes = new WeakMap<object, { input: GainNode; active: boolean; sink: string }>(), slots = new Set<number>()
/** Keep the user's browser output choice while the native device owns playback. */
export function retainArsenalSink(context: object, deviceId: string): boolean {
  const route = routes.get(context); if (!route) return false
  route.sink = deviceId; return route.active
}
/** One stereo bus per AudioContext. No source, speed or pitch processing is replaced. */
export function arsenalDestination(context: AudioContext): AudioNode {
  if (typeof window === 'undefined') return context.destination
  const api = (window as unknown as { bandbuddy?: { arsenal?: ArsenalApi } }).bandbuddy?.arsenal
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined' || !api?.feed) return context.destination
  const existing = routes.get(context); if (existing) return existing.input
  const bus = Array.from({ length: 8 }, (_, i) => i).find(i => !slots.has(i))
  if (bus === undefined) return context.destination
  slots.add(bus)
  const input = context.createGain(), local = context.createGain()
  input.connect(local).connect(context.destination)
  const selector = context as AudioContext & { sinkId?: string | object; setSinkId?(value: string | { type: 'none' }): Promise<void> }
  const route = { input, active: false, sink: typeof selector.sinkId === 'string' ? selector.sinkId : '' }
  routes.set(context, route)
  let node: AudioWorkletNode | undefined, initializationError: Error | undefined
  let worker: Worker | undefined, workerRequest = 0
  const workerRequests = new Map<number, { resolve(): void; reject(error: Error): void }>()
  let desired = false, failed = false, closed = false, prepared = false, epoch = 0, monitorRevision = 0
  let transition = Promise.resolve(), transfers = Promise.resolve()
  const control = (enabled: boolean): void => {
    const message = { enabled, epoch: ++epoch }
    if (worker) worker.postMessage({ control: message })
    else node?.port.postMessage(message)
  }
  const resetWorker = (): Promise<void> => new Promise((resolve, reject) => {
    const id = ++workerRequest
    const timer = setTimeout(() => { workerRequests.delete(id); reject(new Error('伴奏输出重置超时')) }, 5500)
    workerRequests.set(id, { resolve: () => { clearTimeout(timer); resolve() }, reject: error => { clearTimeout(timer); reject(error) } })
    worker!.postMessage({ reset: true, id })
  })
  const serialize = (action: () => Promise<void>): Promise<void> => {
    const next = transition.catch(() => undefined).then(action)
    transition = next
    return next
  }
  const disable = (): void => {
    route.active = false
    control(false)
  }
  const resetBus = (): Promise<void> => {
    // Wait out old sends before resetting/reusing this bus. Old queued packets
    // check their epoch before sending, and cannot affect a new monitor session.
    transfers = transfers.catch(() => undefined).then(async () => {
      if (worker) await resetWorker().catch(() => undefined)
      else await api.feed({ bus, sampleRate: context.sampleRate, samples: [], reset: true }).catch(() => undefined)
    })
    return transfers
  }
  const restore = async (): Promise<void> => {
    prepared = false
    await resetBus()
    if (closed) return
    if (selector.setSinkId) await selector.setSinkId(route.sink)
    local.gain.setValueAtTime(1, context.currentTime)
  }
  const apply = (): void => {
    void serialize(async () => {
      if (closed || !node || initializationError) return
      if (desired && !failed) {
        if (route.active) return
        await transfers
        if (closed || !desired || failed) return
        if (selector.setSinkId) await selector.setSinkId({ type: 'none' })
        if (closed || !desired || failed) return
        prepared = false
        local.gain.setValueAtTime(0, context.currentTime)
        route.active = true
        control(true)
      } else if (!prepared) await restore()
    }).catch(error => {
      disable(); local.gain.value = 1
      reportOutputError(`伴奏输出切换失败：${String(error)}`)
    })
  }
  const failOutput = (reason: string, version: number): void => {
    if (closed || failed || !desired || version !== epoch) return
    failed = true; disable()
    reportOutputError(`${reason}；正在停止监听并恢复常规播放输出。`)
    void api.monitor({ mode: 'off', chain: defaultEffectChain() })
      .catch(error => reportOutputError(String(error))).finally(apply)
  }
  const off = api.onMonitor(state => {
    monitorRevision++
    // Meter events carry the same state; they are not output transitions.
    if (desired === state.active) return
    desired = state.active
    if (!desired) { failed = false; prepared = false; disable() }
    apply()
  })
  const initialRevision = monitorRevision
  void api.monitorState().then(state => {
    if (closed || initialRevision !== monitorRevision) return
    desired = state.active; apply()
  }).catch(error => reportOutputError(String(error)))
  // Small worklets must remain files: the application CSP disallows data: scripts.
  const ready = context.audioWorklet.addModule(outputWorkletUrl).then(async () => {
    if (closed) return
    node = new AudioWorkletNode(context, 'bandbuddy-arsenal-output', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
    input.connect(node).connect(context.destination)
    if (api.outputTransport && typeof Worker !== 'undefined') {
      const url = await api.outputTransport(bus)
      if (closed) return
      worker = new Worker(new URL('./native-output.worker.js', import.meta.url), { type: 'module' })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('伴奏工作线程启动超时')), 5000)
        worker!.onerror = event => {
          clearTimeout(timer); reject(new Error(event.message))
          failOutput('伴奏工作线程中断', epoch)
        }
        worker!.onmessage = ({ data }: MessageEvent<{ ready?: boolean; id?: number; error?: string; epoch?: number }>) => {
          if (data.ready) { clearTimeout(timer); resolve(); return }
          if (data.id) {
            const pending = workerRequests.get(data.id); workerRequests.delete(data.id)
            if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve()
          } else if (data.error) failOutput(`伴奏传输中断：${data.error}`, data.epoch ?? epoch)
        }
        // Transfer the port itself; PCM never traverses the window event loop.
        worker!.postMessage({ port: node!.port, url, sampleRate: context.sampleRate }, [node!.port])
      })
    } else node.port.onmessage = event => {
      const packet = event.data as { epoch: number; time: number; samples: Float32Array }
      if (closed || !route.active || packet.epoch !== epoch) return
      const version = epoch
      transfers = transfers.catch(() => undefined).then(async () => {
        if (closed || !route.active || version !== epoch) return
        // A stalled renderer may receive a bounded burst later. Do not replay
        // old accompaniment or interpret a busy UI as a failed audio device.
        if (context.currentTime - packet.time > .12) return
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const ok = await Promise.race([
            api.feed({ bus, sampleRate: context.sampleRate, samples: Array.from(packet.samples) }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('伴奏传输超时')), 5000) })
          ])
          if (!ok) failOutput('原生输出已关闭', version)
        } catch (error) { failOutput(`伴奏传输中断：${String(error)}`, version) }
        finally { clearTimeout(timer) }
      }).finally(() => {
        if (!closed && version === epoch) node?.port.postMessage({ ack: true, epoch: version })
      })
    }
    apply()
  }).catch(error => {
    initializationError = new Error(`无法启动统一音频输出：${String(error)}`)
    reportOutputError(initializationError.message)
  })
  const managed = {
    prepare: async (): Promise<void> => {
      await ready
      await serialize(async () => {
        if (closed) return
        if (!node || initializationError) throw initializationError ?? new Error('统一输出模块未就绪')
        prepared = true; local.gain.setValueAtTime(0, context.currentTime)
        if (selector.setSinkId) await selector.setSinkId({ type: 'none' })
      })
    },
    restore: async (): Promise<void> => { disable(); await serialize(restore) }
  }
  nativeOutputRoutes.add(managed)
  const dispose = (): void => {
    if (context.state !== 'closed') return
    closed = true; disable(); off(); nativeOutputRoutes.delete(managed); routes.delete(context)
    node?.disconnect(); input.disconnect(); local.disconnect()
    void resetBus().finally(() => { worker?.terminate(); slots.delete(bus) })
    context.removeEventListener('statechange', dispose)
  }
  context.addEventListener('statechange', dispose)
  return input
}
