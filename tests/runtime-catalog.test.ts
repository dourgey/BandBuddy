import { describe, expect, it } from 'vitest'
import { assertProfileSystem, chooseRuntimeProfile, loadRuntimeProfiles, validateRuntimeProfile } from '../src/main/runtime-catalog.js'
import { readFile } from 'node:fs/promises'
import { modelCatalog } from '../src/main/model-catalog.js'

describe('committed complete runtime profiles', () => {
  it.each(['win32-x64', 'darwin-arm64'])('has immutable binary-only dependency closures for %s', async target => {
    const profiles = await loadRuntimeProfiles('resources', target)
    expect(profiles.length).toBeGreaterThan(0)
    for (const profile of profiles) {
      expect(profile.wheels.length).toBeGreaterThan(50)
      expect(profile.wheels.every(file => file.version && file.sha256.length === 64 && file.urls.every(url => url.startsWith('https://')))).toBe(true)
      expect(profile.wheels.find(file => file.id === 'torch')?.version).toMatch(/^2\.11\.0/)
      expect(profile.wheels.find(file => file.id === 'soundfile')?.filename).not.toContain('-any.whl')
      expect(() => validateRuntimeProfile({ ...profile, wheels: profile.wheels.slice(0, 2) })).toThrow()
    }
  })
  it('uses architecture and driver gates and always has an independent CPU fallback', async () => {
    const profiles = await loadRuntimeProfiles('resources', 'win32-x64')
    expect(chooseRuntimeProfile(profiles, 'auto', { driverVersion: '590.0', computeCapability: '8.6' }).backend).toBe('cu130')
    expect(chooseRuntimeProfile(profiles, 'auto', { driverVersion: '573.0', computeCapability: '8.6' }).backend).toBe('cu128')
    expect(chooseRuntimeProfile(profiles, 'auto', { driverVersion: '590.0', computeCapability: '6.1' }).backend).toBe('cpu')
    expect(chooseRuntimeProfile(profiles, 'cuda', null).backend).toBe('cpu')
    expect(chooseRuntimeProfile(profiles, 'cpu', { driverVersion: '590.0', computeCapability: '8.6' }).backend).toBe('cpu')
  })
  it('rejects the macOS feature below its native wheel minimum before downloading', async () => {
    const [profile] = await loadRuntimeProfiles('resources', 'darwin-arm64')
    expect(() => assertProfileSystem(profile!, '22.6.0')).toThrow('UNSUPPORTED_SYSTEM')
    expect(() => assertProfileSystem(profile!, '23.0.0')).not.toThrow()
  })
  it('preserves every original model file, size and hash', async () => {
    const catalog = await modelCatalog('resources'), worker = await readFile('python/worker/model_download.py', 'utf8')
    expect(catalog.files).toHaveLength(6)
    for (const artifact of catalog.files) { expect(worker).toContain(artifact.sha256); expect(worker).toContain(artifact.filename); expect(worker.replaceAll('_', '')).toContain(String(artifact.size)) }
  })
})
