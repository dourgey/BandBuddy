import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { x as extractTar } from 'tar'
import type { Artifact } from './artifact-download.js'
import { writeJsonAtomic } from './artifact-download.js'
import { compareRuntimeVersions } from './windows-prerequisites.js'

export interface RuntimeProfile {
  schema: 1; id: string; target: string; backend: string
  minimumSystem: string; minimumDriver: string | null; minimumComputeCapability: string | null
  python: Artifact & { version: string }
  wheels: Array<Artifact & { version: string }>
}
export function validateRuntimeProfile(profile: RuntimeProfile): RuntimeProfile {
  if (profile.schema !== 1 || !/^(win32-x64|darwin-arm64)-(cpu|cu126|cu128|cu129|cu130)$/.test(profile.id) || !profile.wheels.length) throw new Error('RUNTIME_PROFILE_INVALID')
  if (profile.id !== `${profile.target}-${profile.backend}` || !/^\d+\.\d+(?:\.\d+)?$/.test(profile.minimumSystem)) throw new Error('RUNTIME_PROFILE_INVALID')
  const ids = new Set<string>()
  for (const artifact of [profile.python, ...profile.wheels]) {
    if (!/^[\w.+-]+$/.test(artifact.filename) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !artifact.size || artifact.size <= 0 || !artifact.expandedSize || !artifact.urls.length || artifact.urls.some(url => new URL(url).protocol !== 'https:') || ids.has(artifact.id)) throw new Error('RUNTIME_PROFILE_ARTIFACT_INVALID')
    ids.add(artifact.id)
  }
  if (profile.wheels.some(wheel => !wheel.filename.endsWith('.whl'))) throw new Error('RUNTIME_SOURCE_BUILD_FORBIDDEN')
  for (const required of ['torch', 'torchaudio', 'demucs', 'numpy', 'librosa']) if (!ids.has(required)) throw new Error('RUNTIME_PROFILE_INCOMPLETE')
  if (!ids.has('onnxruntime') && !ids.has('onnxruntime-gpu')) throw new Error('RUNTIME_PROFILE_INCOMPLETE')
  return profile
}
export async function loadRuntimeProfiles(packagedRoot: string, target = `${process.platform}-${process.arch}`): Promise<RuntimeProfile[]> {
  const root = existsSync(path.join(packagedRoot, 'runtime-catalog')) ? path.join(packagedRoot, 'runtime-catalog') : path.join(process.cwd(), 'resources/runtime-catalog')
  const files = await readdir(root).catch(() => [] as string[])
  const profiles = await Promise.all(files.filter(name => name.startsWith(`${target}-`) && name.endsWith('.json')).map(async name => validateRuntimeProfile(JSON.parse(await readFile(path.join(root, name), 'utf8')))))
  if (profiles.some(profile => profile.target !== target)) throw new Error('RUNTIME_PROFILE_TARGET_MISMATCH')
  if (!profiles.some(profile => profile.backend === 'cpu')) throw new Error(`RUNTIME_PROFILE_MISSING:${target}`)
  return profiles
}
export function chooseRuntimeProfile(profiles: RuntimeProfile[], preferred: string, gpu?: { driverVersion: string; computeCapability: string } | null): RuntimeProfile {
  const cpu = profiles.find(profile => profile.backend === 'cpu')
  if (!cpu) throw new Error('RUNTIME_PROFILE_CPU_MISSING')
  if (preferred === 'cpu' || preferred === 'mps' || !gpu) return cpu
  return profiles.filter(profile => profile.backend !== 'cpu' && profile.minimumDriver && profile.minimumComputeCapability
    && compareRuntimeVersions(gpu.driverVersion, profile.minimumDriver) >= 0
    && compareRuntimeVersions(gpu.computeCapability, profile.minimumComputeCapability) >= 0).sort((a, b) => b.backend.localeCompare(a.backend))[0] ?? cpu
}
export function assertProfileSystem(profile: RuntimeProfile, release = os.release()): void {
  const current = profile.target.startsWith('darwin') ? String(Number(release.split('.')[0]) - 9) + '.0' : release
  if (compareRuntimeVersions(current, profile.minimumSystem) < 0) throw new Error(`UNSUPPORTED_SYSTEM:${profile.target}:${profile.minimumSystem}`)
}
export async function extractInterpreter(archive: string, root: string, artifact: Artifact, signal: AbortSignal, replacement = false): Promise<string> {
  const destination = path.join(root, 'interpreters', artifact.sha256.slice(0, 24) + (replacement ? `-${randomUUID()}` : ''))
  const executable = process.platform === 'win32' ? path.join(destination, 'python', 'python.exe') : path.join(destination, 'python', 'bin', 'python3.12')
  const marker = path.join(destination, '.complete.json')
  if (existsSync(executable) && existsSync(marker)) return executable
  await mkdir(destination, { recursive: true })
  await extractTar({ file: archive, cwd: destination, strict: true, preservePaths: false, filter: name => {
    signal.throwIfAborted()
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('UNSAFE_ARCHIVE_PATH')
    return true
  } })
  signal.throwIfAborted()
  if (!existsSync(executable)) throw new Error('PYTHON_ARCHIVE_INVALID')
  await writeJsonAtomic(marker, { sha256: artifact.sha256 })
  return executable
}
