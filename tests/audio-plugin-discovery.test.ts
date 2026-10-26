import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPluginService, defaultPluginDirectories } from '../src/main/audio-plugins.js'

const scanner = vi.hoisted(() => ({ calls: [] as string[], afterScan: undefined as (() => void) | undefined }))
vi.mock('../src/main/process.js', () => ({ spawnSafe: (_exe: string, args: string[]) => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  const candidate = args[1]!
  scanner.calls.push(candidate)
  setImmediate(() => {
    if (candidate.includes('broken')) { child.stderr.write('invalid plugin'); child.emit('close', 1); return }
    child.stdout.write(JSON.stringify([{ format: 'vst3', pluginId: path.basename(candidate), path: candidate,
      name: path.basename(candidate), validation: 'available', inputChannels: 1, outputChannels: 2, latencyFrames: 64, hasEditor: true }]) + '\n')
    scanner.afterScan?.()
    child.emit('close', 0)
  })
  return child
} }))

describe.runIf(process.platform === 'win32')('Windows automatic plugin discovery', () => {
let root: string, directory: string, service: AudioPluginService, occupied = false
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bb-discovery-'))
  vi.stubEnv('LOCALAPPDATA', root); vi.stubEnv('ProgramFiles', root)
  vi.stubEnv('CommonProgramFiles', path.join(root, 'Common Files')); vi.stubEnv('CommonProgramW6432', path.join(root, 'Common Files'))
  directory = defaultPluginDirectories()[0]!
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(root, process.platform === 'win32' ? 'bandbuddy-plugin-host.exe' : 'bandbuddy-plugin-host'), '')
  occupied = false; scanner.calls = []; scanner.afterScan = undefined
  service = new AudioPluginService({ dataRoot: root, audioHostExecutable: () => path.join(root, 'audio-host') } as never, () => occupied)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('discovers standard directories without configuration, caches validation, and refreshes installs, updates and removals', async () => {
  const file = path.join(directory, 'effect.vst3')
  await writeFile(file, 'v1')
  const first = await service.scan()
  expect(first.directories).toEqual([])
  expect(first.plugins[0]).toMatchObject({ inputChannels: 1, outputChannels: 2, latencyFrames: 64, hasEditor: true, architecture: process.arch })
  await service.scan(); expect(scanner.calls).toHaveLength(1)
  await writeFile(file, 'v2')
  await writeFile(path.join(directory, 'new.vst3'), 'new')
  const updated = await service.scan()
  expect(updated.plugins).toHaveLength(2)
  expect(updated.plugins.find(p => p.name === 'effect.vst3')?.fingerprint).not.toBe(first.plugins[0]!.fingerprint)
  expect(scanner.calls).toHaveLength(3)
  await rm(file)
  expect((await service.scan()).plugins.map(p => p.name)).toEqual(['new.vst3'])
})

it('isolates failed and interrupted binaries until they change or are explicitly retried', async () => {
  const file = path.join(directory, 'broken.vst3')
  await writeFile(file, 'v1')
  const failed = await service.scan(); expect(failed.failures).toHaveLength(1)
  await service.scan(); expect(scanner.calls).toHaveLength(1)
  await writeFile(file, 'v2'); await service.scan(); expect(scanner.calls).toHaveLength(2)
  await service.scan(true); expect(scanner.calls).toHaveLength(3)
  const interrupted = path.join(directory, 'interrupted.vst3')
  await writeFile(interrupted, 'v1')
  const catalog = await service.scan()
  const plugin = catalog.plugins[0]!
  await writeFile(path.join(root, 'audio-plugins/scanning.json'), JSON.stringify({ path: plugin.path, fingerprint: plugin.fingerprint }))
  expect((await service.scan()).failures.find(f => f.path === plugin.path)?.reason).toContain('已隔离')
})

it('defers while audio is occupied and preserves unvisited plugins if audio starts during a refresh', async () => {
  await writeFile(path.join(directory, 'a.vst3'), 'v1'); await writeFile(path.join(directory, 'b.vst3'), 'v1')
  const initial = await service.scan()
  occupied = true
  expect(await service.scan()).toMatchObject({ plugins: initial.plugins, scanDeferred: true })
  expect(scanner.calls).toHaveLength(2)
  occupied = false
  await writeFile(path.join(directory, 'a.vst3'), 'v2')
  scanner.afterScan = () => { occupied = true }
  const paused = await service.scan()
  expect(paused.scanDeferred).toBe(true); expect(paused.plugins).toHaveLength(2)
  occupied = false; scanner.afterScan = undefined
  expect((await service.scan()).scanDeferred).toBe(false)
})

it('coalesces concurrent automatic refresh requests', async () => {
  await writeFile(path.join(directory, 'effect.vst3'), 'v1')
  const one = service.scan(), two = service.scan()
  expect(one).toBe(two)
  await Promise.all([one, two]); expect(scanner.calls).toHaveLength(1)
})

it.runIf(process.platform === 'win32')('follows directory junctions and deduplicates physical plugins without following cycles', async () => {
  const target = path.join(root, 'vendor')
  await mkdir(target); await writeFile(path.join(target, 'effect.vst3'), 'v1')
  await symlink(target, path.join(directory, 'vendor'), 'junction')
  await symlink(directory, path.join(target, 'cycle'), 'junction')
  await service.addDirectory(target)
  expect((await service.scan()).plugins).toHaveLength(1)
  expect(scanner.calls).toEqual([await realpath(path.join(target, 'effect.vst3'))])
})
})
