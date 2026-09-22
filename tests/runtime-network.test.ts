import { beforeEach, describe, expect, it, vi } from 'vitest'
import { proxyEnvironment, proxyFromPac, RuntimeNetwork } from '../src/main/runtime-network.js'

const mocks = vi.hoisted(() => ({ setProxy: vi.fn(), resolveProxy: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => mocks } }))
const network = { proxyMode: 'manual' as const, proxyUrl: 'http://127.0.0.1:7890', pythonInstallMirror: '', pythonIndexUrl: '', pytorchIndexUrl: '' }
beforeEach(() => { vi.clearAllMocks(); mocks.setProxy.mockResolvedValue(undefined) })

describe('consistent runtime network policy', () => {
  it('disables inherited lowercase and uppercase proxies for every child client', () => {
    const env = proxyEnvironment({ http_proxy: 'old', HTTPS_PROXY: 'old', ALL_PROXY: 'old', PATH: 'keep' }, { ...network, proxyMode: 'none' })
    expect(env).toEqual({ PATH: 'keep', NO_PROXY: '*', no_proxy: '*' })
  })
  it('replaces all inherited proxies when a manual HTTP proxy is selected', () => {
    const env = proxyEnvironment({ all_proxy: 'socks://old', no_proxy: '*'}, network)
    expect(env.https_proxy).toBe(network.proxyUrl)
    expect(env.all_proxy).toBeUndefined()
    expect(env.no_proxy).toBeUndefined()
  })
  it('resolves system HTTP proxies and never silently bypasses a SOCKS-only policy', () => {
    expect(proxyFromPac('PROXY localhost:8080; DIRECT')).toBe('http://localhost:8080')
    expect(proxyFromPac('DIRECT')).toBeNull()
    expect(() => proxyFromPac('SOCKS5 localhost:1080; DIRECT')).toThrow('SYSTEM_PROXY_SOCKS_UNSUPPORTED')
  })
  it('retries only supplied HTTPS sources while retaining the selected proxy', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(new Response('verified later'))
    const bytes = await new RuntimeNetwork().bytes(['https://first.example/a', 'https://second.example/a'], network, new AbortController().signal)
    expect(bytes.toString()).toBe('verified later')
    expect(mocks.setProxy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'fixed_servers', proxyRules: network.proxyUrl }))
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual(['https://first.example/a', 'https://first.example/a', 'https://second.example/a'])
  })
  it('does not retry cancelled requests', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new RuntimeNetwork().bytes(['https://first.example/a'], network, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
