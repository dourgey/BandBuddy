import { readFile } from 'node:fs/promises'

export interface RuntimeWheel {
  name: 'sphn'
  version: '0.1.12'
  filename: string
  url: string
  sha256: string
}

export function validateIntelWheel(input: unknown): RuntimeWheel {
  const value = input as Partial<RuntimeWheel> | null
  if (!value || value.name !== 'sphn' || value.version !== '0.1.12'
    || value.filename !== 'sphn-0.1.12-cp312-cp312-macosx_13_0_x86_64.whl'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.url !== 'string') throw new Error('INTEL_RUNTIME_WHEEL_INVALID')
  const url = new URL(value.url)
  const trusted = (url.hostname === 'github.com' && url.pathname.startsWith('/dourgey/BandBuddy/releases/download/'))
    || (url.hostname === 'modelscope.cn' && url.pathname.startsWith('/models/Zzzzzzorz/BandBuddy-Models/resolve/'))
  if (url.protocol !== 'https:' || url.username || url.password || !trusted || !url.pathname.endsWith(`/${value.filename}`)) throw new Error('INTEL_RUNTIME_WHEEL_SOURCE_INVALID')
  return value as RuntimeWheel
}

export async function intelSphnRequirement(packagedManifest: string): Promise<string> {
  const text = await readFile(packagedManifest, 'utf8').catch(() => { throw new Error('INTEL_RUNTIME_WHEEL_NOT_PUBLISHED:此安装包尚未包含 Intel 分轨组件清单，请使用完整的 Intel 发行版') })
  const manifest = JSON.parse(text) as { schema?: number; wheels?: Record<string, unknown> }
  if (manifest.schema !== 1) throw new Error('INTEL_RUNTIME_WHEEL_MANIFEST_INVALID')
  const wheel = validateIntelWheel(manifest.wheels?.['darwin-x64-cp312'])
  return `sphn @ ${wheel.url}#sha256=${wheel.sha256}`
}

export async function validateIntelRuntimeLock(file: string, sphnRequirement: string): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => { throw new Error('INTEL_RUNTIME_LOCK_MISSING') })
  const [source, digest] = sphnRequirement.split('#sha256=')
  if (!source || !digest) throw new Error('INTEL_RUNTIME_LOCK_INVALID')
  const sphnUrl = new URL(source.slice('sphn @ '.length))
  const releaseRoot = sphnUrl.href.slice(0, sphnUrl.href.lastIndexOf('/') + 1)
  const entries = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const found = new Map<string, { filename: string; hashes: string[]; url: string }>()
  for (const entry of entries) {
    const match = /^([a-z0-9_.-]+)(?:\[[a-z0-9_,.-]+\])?\s*@\s*(https:\/\/\S+)\s+((?:--hash=sha256:[a-f0-9]{64}\s*)+)$/i.exec(entry)
    if (!match) throw new Error('INTEL_RUNTIME_LOCK_INVALID')
    const url = new URL(match[2]!)
    const canonical = url.href.split('#')[0]!
    const filename = url.pathname.split('/').pop()!
    const name = match[1]!.toLowerCase().replace(/[-_.]+/g, '-')
    if (!canonical.startsWith(releaseRoot) || canonical.slice(releaseRoot.length).includes('/')
      || url.username || url.password || url.search || !filename.endsWith('.whl') || found.has(name)) throw new Error('INTEL_RUNTIME_LOCK_SOURCE_INVALID')
    found.set(name, { filename, url: canonical, hashes: [...match[3]!.matchAll(/sha256:([a-f0-9]{64})/g)].map(value => value[1]!) })
  }
  if (!found.get('torch')?.filename.startsWith('torch-2.2.2-') || !found.get('numpy')?.filename.startsWith('numpy-1.26.4-')
    || found.get('sphn')?.url !== sphnUrl.href || !found.get('sphn')?.hashes.includes(digest)) throw new Error('INTEL_RUNTIME_LOCK_INVALID')
}
