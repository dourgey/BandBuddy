import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_AI_SETTINGS } from '../packages/shared/src/ai.js'
import type { AiMessage } from '../packages/shared/src/ai.js'
import type { AppSettings } from '../packages/shared/src/domain.js'
import type { DiagnosticReport } from '../packages/shared/src/environment.js'
import { AI_INTENT_PROMPT, BANGBANG_PERSONA, aiGuideContext, parseAiIntent, prepareAiAnswer } from '../src/main/ai-assistant.js'
import { AiInformationReader, type AiInformationSources } from '../src/main/ai-information.js'
import { guardAiReply, redactAiSecrets } from '../src/main/ai-security.js'

const roots: string[] = []
const config = { settings: { ...DEFAULT_AI_SETTINGS, baseUrl: 'https://example.invalid/v1', model: 'configured-model' }, token: 'sk-test-private-key' }
const user = (text: string): AiMessage => ({ id: 'user', conversationId: 'chat', role: 'user', text, images: [], status: 'complete', error: null, model: null, createdAt: '', revision: 0, finishReason: null })
function router(text: string) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }))
}
async function prepare(route: string, history = [user('帮我看看')], reader = { read: vi.fn(async () => '本轮采集时间：2026-10-16T00:00:00Z；任务 separating，进度 36%，错误 DEVICE_BUSY') }) {
  const fetcher = router(route)
  const result = await prepareAiAnswer({ config, history, reader, fetch: fetcher, signal: new AbortController().signal, secrets: [config.token] })
  return { ...result, fetcher, reader }
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('model-based intent routing and grounded answers', () => {
  it('asks the configured API to classify, then references the selected packaged operation guide', async () => {
    const result = await prepare('{"intent":"help","topics":["practice"],"scopes":[]}', [user('怎么设置 AB 循环？')])
    const [url, init] = result.fetcher.mock.calls[0]!
    expect(url).toBe('https://example.invalid/v1/chat/completions')
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${config.token}` })
    const request = JSON.parse(String(init?.body))
    expect(request).toMatchObject({ model: 'configured-model', stream: false, messages: [{ role: 'system', content: AI_INTENT_PROMPT }, { role: 'user', content: '怎么设置 AB 循环？' }] })
    expect(result.body.model).toBe('configured-model')
    const instructions = (result.body.messages as any[])[0].content
    expect(instructions).toContain(BANGBANG_PERSONA)
    expect(instructions).toContain('第一次设 A，第二次设 B')
    expect(instructions).toContain('来源：README.md')
    expect(instructions).not.toContain('局域网练琴】')
    expect(result.reader.read).not.toHaveBeenCalled()
  })
  it('fetches only the requested live scopes and includes evidence and a related guide', async () => {
    const result = await prepare('{"intent":"status","topics":["recording"],"scopes":["audio","logs","audio"]}')
    expect(result.reader.read).toHaveBeenCalledExactlyOnceWith(['audio', 'logs'], expect.any(AbortSignal))
    const prompt = (result.body.messages as any[])[0].content
    expect(prompt).toContain('DEVICE_BUSY')
    expect(prompt).toContain('2026-10-16T00:00:00Z')
    expect(prompt).toContain('设备与驱动是否真实可用')
    expect(prompt).toContain('只读采集结果')
  })
  it('keeps ordinary conversations free of document retrieval and state collection', async () => {
    const result = await prepare('{"intent":"other","topics":[],"scopes":[]}', [user('给我一个 C 大调和弦进行')])
    expect((result.body.messages as any[])[0]).toEqual({ role: 'system', content: BANGBANG_PERSONA })
    expect(result.reader.read).not.toHaveBeenCalled()
  })
  it('uses an explicitly supported non-thinking mode for routing without forcing vendor extensions elsewhere', async () => {
    const fetcher = router('{"intent":"other"}')
    await prepareAiAnswer({ config: { ...config, settings: { ...config.settings, extraBody: '{"enable_thinking":true}' } }, history: [user('你好')], fetch: fetcher, signal: new AbortController().signal, secrets: [] })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).enable_thinking).toBe(false)
    const ordinary = await prepare('{"intent":"other"}')
    expect(JSON.parse(String(ordinary.fetcher.mock.calls[0]![1]?.body))).not.toHaveProperty('enable_thinking')
  })
  it('gives the classifier recent conversation context, including image questions, with keys removed', async () => {
    const image = { id: 'photo', name: '设置.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }
    const history = [user('我在查看分轨进度'), { ...user('正在进行'), role: 'assistant' as const }, { ...user(`那现在呢 ${config.token}`), images: [image] }]
    const result = await prepare('{"intent":"status","topics":[],"scopes":["separation"]}', history)
    const request = JSON.parse(String(result.fetcher.mock.calls[0]![1]?.body))
    expect(JSON.stringify(request)).toContain('我在查看分轨进度')
    expect(JSON.stringify(request)).toContain(image.dataUrl)
    expect(JSON.stringify(request)).not.toContain(config.token)
    expect(JSON.stringify(result.body)).not.toContain(config.token)
  })
  it('does not let malformed or invented scope/path output trigger local reads', async () => {
    for (const text of ['你好', '{"intent":"status","scopes":["C:/private/file"]}', '{"intent":"execute","command":"delete"}']) {
      const reader = { read: vi.fn() }
      await expect(prepare(text, [user('查询状态')], reader)).rejects.toThrow('问题的类型')
      expect(reader.read).not.toHaveBeenCalled()
    }
    expect(parseAiIntent('```json\n{"intent":"help","topics":["overview"]}\n```').intent).toBe('help')
  })
  it('reports unavailable status instead of inventing it, and redacts returned state before context', async () => {
    const reader = { read: vi.fn(async () => { throw new Error(`DEVICE_BUSY ${config.token}`) }) }
    const result = await prepare('{"intent":"status","scopes":["audio"]}', [user('设备状态？')], reader)
    const prompt = (result.body.messages as any[])[0].content
    expect(prompt).toContain('本次读取失败')
    expect(prompt).toContain('DEVICE_BUSY')
    expect(prompt).not.toContain(config.token)
  })
  it('cancels while waiting for local information and does not build an answer with stale data', async () => {
    const controller = new AbortController()
    const reader = { read: vi.fn(async () => { controller.abort(new Error('cancelled')); return '旧状态' }) }
    await expect(prepareAiAnswer({ config, history: [user('现在怎么样？')], reader, fetch: router('{"intent":"status","scopes":["separation"]}'), signal: controller.signal, secrets: [] })).rejects.toThrow('cancelled')
  })
  it('documents every routed software topic and keeps context limited to allowed topics', () => {
    for (const topic of ['overview', 'library', 'practice', 'recording', 'rehearsal', 'woodshed', 'arsenal', 'settings', 'export', 'network', 'ai']) expect(aiGuideContext([topic])).toContain('来源：')
    expect(aiGuideContext(['../../secret'])).toBe('')
  })
})

describe('secret and identity guard on model output', () => {
  it('redacts known keys, encoded versions, unknown SKs and Bearer credentials', () => {
    const secret = 'custom-private-api-key'
    for (const value of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), 'sk-randomprivatekey123', 'Bearer arbitrary-private-key']) {
      const safe = redactAiSecrets(`测试 ${value}`, [secret])
      expect(safe).not.toContain(value)
      expect(safe).toContain('密钥已隐藏')
    }
  })
  it('does not emit secret prefixes even if SSE delivers a key one character at a time', () => {
    const secret = 'custom-private-api-key'
    for (const value of [secret, Buffer.from(secret).toString('base64'), 'sk-randomprivatekey123']) {
      for (let index = 1; index <= value.length; index++) {
        const safe = guardAiReply(`开始 ${value.slice(0, index)}`, [secret], [])
        expect(safe).not.toContain(value.slice(0, Math.min(index, 6)))
      }
      expect(guardAiReply(`开始 ${value}`, [secret], [], true)).toContain('密钥已隐藏')
    }
    expect(guardAiReply('开始 custom-private-', [secret], [], true)).not.toContain('custom-private-')
  })
  it('introduces Bangbang without exposing model identity, while preserving ordinary provider instructions', () => {
    const models = ['Vendor/Model(4B)']
    for (const text of ['我是 Qwen，由阿里训练。', '我是 Vendor/Model(4B) 模型。', 'I am an OpenAI model.']) {
      expect(guardAiReply(text, [], models, true)).toContain('邦邦')
      expect(guardAiReply(text, [], models, true)).not.toMatch(/Qwen|阿里|Vendor|OpenAI/)
    }
    expect(guardAiReply('我是 Qw', [], models)).toBe('')
    expect(guardAiReply('接口支持 OpenAI 兼容格式。', [], models, true)).toBe('接口支持 OpenAI 兼容格式。')
  })
})

async function information() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-ai-information-')); roots.push(root)
  const settings = { appearance: { theme: 'dark' }, libraryRoot: 'C:/private/songs', runtimeRoot: 'C:/private/runtime', modelRoot: 'C:/private/models',
    debugMode: false, preferredDevice: 'cpu', latencyMode: 'balanced', recordingAudio: { backend: 'asio', inputDeviceId: 'guitar', sampleRate: 48000, bufferFrames: 128 },
    network: { proxyMode: 'manual', proxyUrl: 'https://user:password@proxy.invalid', pythonIndexUrl: 'https://index.invalid?token=secret' } } as AppSettings
  const sources = { application: vi.fn(() => ({ version: '3.0.0' })), settings: vi.fn(() => settings),
    devices: vi.fn(async () => [{ id: 'guitar', name: 'USB Guitar', backend: 'asio' as const, inputChannels: 2, outputChannels: 2, duplexChannels: 2, sampleRates: [48000], preferredSampleRate: 48000, defaultInput: true, defaultOutput: true }]),
    separation: vi.fn(() => ({ runtime: { status: 'missing' }, environment: { phase: 'paused' }, jobs: [] })),
    diagnostics: vi.fn(() => ({ schema: 2, applicationVersion: '3.0.0', issues: [], events: [], persistenceError: null } as unknown as DiagnosticReport)),
    logsRoot: root, flushLogs: vi.fn(async () => {}) } satisfies AiInformationSources
  return { root, settings, sources, reader: new AiInformationReader(sources) }
}
describe('scoped read-only software information', () => {
  it('reads settings without enumerating devices/logs, excludes credentials and observes subsequent changes', async () => {
    const { reader, sources, settings } = await information()
    const first = await reader.read(['settings'], new AbortController().signal)
    expect(first).toContain('48000')
    expect(first).not.toMatch(/private\/|proxy\.invalid|password|index\.invalid|secret/)
    expect(sources.devices).not.toHaveBeenCalled()
    expect(sources.diagnostics).not.toHaveBeenCalled()
    expect(sources.flushLogs).not.toHaveBeenCalled()
    settings.recordingAudio.sampleRate = 44100
    expect(await reader.read(['settings'], new AbortController().signal)).toContain('44100')
  })
  it('returns usable sections alongside device failure and includes fresh collection time', async () => {
    const { reader, sources } = await information()
    sources.devices.mockRejectedValue(new Error('DEVICE_BUSY at C:/private/driver'))
    const report = JSON.parse(await reader.read(['audio', 'application'], new AbortController().signal))
    expect(report.collectedAt).toBeTruthy()
    expect(report.access).toBe('read-only')
    expect(report.sections[0]).toMatchObject({ scope: 'audio', status: 'unavailable' })
    expect(report.sections[1]).toMatchObject({ scope: 'application', status: 'ok', value: { version: '3.0.0' } })
    expect(JSON.stringify(report)).not.toContain('private/driver')
  })
  it('reads only bounded fixed log tails and removes embedded SKs and paths', async () => {
    const { reader, root, sources } = await information()
    await writeFile(path.join(root, 'bandbuddy.log'), [JSON.stringify({ level: 'info', message: 'not-in-error-log' }),
      ...Array.from({ length: 50 }, (_, i) => JSON.stringify({ level: 'error', message: `DEVICE_BUSY ${i} sk-privatekey987 C:/private/driver` }))].join('\n'))
    const report = JSON.parse(await reader.read(['logs'], new AbortController().signal))
    const logs = report.sections[0].value
    expect(logs.applicationLog.entries).toHaveLength(30)
    expect(logs.debugLog.error).toBe('日志文件尚未生成。')
    expect(sources.flushLogs).toHaveBeenCalledOnce()
    expect(JSON.stringify(logs)).not.toMatch(/sk-privatekey987|C:\/private|not-in-error-log/)
    expect(logs.applicationLog.note).toContain('不代表全部历史')
    expect(sources.devices).not.toHaveBeenCalled()
  })
  it('bounds device enumeration and permits cancellation without reading other scopes', async () => {
    const { reader, sources } = await information()
    sources.devices.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    const request = reader.read(['audio'], new AbortController().signal)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await request).toContain('读取超时')
    const controller = new AbortController()
    const cancelled = expect(reader.read(['audio'], controller.signal)).rejects.toBe('user')
    controller.abort('user')
    await cancelled
    expect(sources.separation).not.toHaveBeenCalled()
  })
})
