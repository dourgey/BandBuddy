const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { open, readdir } = require('node:fs/promises')
const path = require('node:path')
const policy = require('../resources/macos-signing.json')
const execute = promisify(execFile)
const machoMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const codeBundles = new Set(['.app', '.framework', '.xpc', '.appex', '.bundle'])
const publisherRequirement = `=anchor apple generic and certificate leaf[subject.OU] = "${policy.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`
const appRequirement = `${publisherRequirement} and identifier "${policy.appId}"`

async function run(command, args, options = {}) {
  return execute(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options })
}

function selectIdentity(output, requested) {
  const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"]+)"/g)]
    .map(match => ({ hash: match[1].toUpperCase(), name: match[2] }))
    .filter(identity => identity.name.endsWith(`(${policy.teamId})`))
    .sort((a, b) => a.hash.localeCompare(b.hash))
  const selected = requested
    ? identities.find(identity => identity.hash === requested.toUpperCase() || identity.name === requested)
    : identities[0]
  if (!selected) throw new Error(`MAC_SIGNING_IDENTITY_MISSING: a valid Developer ID Application certificate for team ${policy.teamId} is required`)
  return selected
}

async function scanCode(appPath) {
  const root = path.resolve(appPath)
  const binaries = []
  const bundles = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      // Framework symlinks point to the same files. Never traverse them again.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(file)
        if (codeBundles.has(path.extname(entry.name))) bundles.push(file)
      } else if (entry.isFile()) {
        const handle = await open(file, 'r')
        try {
          const bytes = Buffer.alloc(4)
          const { bytesRead } = await handle.read(bytes, 0, 4, 0)
          if (bytesRead === 4 && machoMagic.has(bytes.toString('hex'))) binaries.push(file)
        } finally { await handle.close() }
      }
    }
  }
  await walk(root)
  bundles.push(root)
  return { binaries: binaries.sort(), bundles: bundles.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b)) }
}

function assertRequiredCode(appPath, inventory) {
  const relative = inventory.binaries.map(file => path.relative(appPath, file).split(path.sep).join('/'))
  const required = ['Contents/MacOS/BandBuddy', 'Contents/Resources/bin/uv', 'Contents/Resources/bin/ffmpeg', 'Contents/Resources/bin/ffprobe']
  for (const file of required) if (!relative.includes(file)) throw new Error(`MAC_REQUIRED_BINARY_MISSING:${file}`)
  if (!relative.some(file => /^Contents\/Resources\/audio-host\/darwin-(arm64|x64)\/bandbuddy-audio-host$/.test(file))) throw new Error('MAC_REQUIRED_BINARY_MISSING:audio-host')
  if (!relative.some(file => file.endsWith('/better_sqlite3.node'))) throw new Error('MAC_REQUIRED_BINARY_MISSING:better_sqlite3.node')
}

function deploymentTargets(commands) {
  return commands.split('Load command').filter(block => /LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX/.test(block))
    .flatMap(block => [...block.matchAll(/\b(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]))
}

async function verifyArchitecture(appPath, architecture = process.arch, inventory = null) {
  const expected = architecture === 'x64' ? 'x86_64' : architecture
  if (!['x86_64', 'arm64'].includes(expected)) throw new Error(`MAC_ARCHITECTURE_UNSUPPORTED:${architecture}`)
  const code = inventory ?? await scanCode(appPath)
  assertRequiredCode(appPath, code)
  if (!code.binaries.some(file => file.endsWith(`/audio-host/darwin-${architecture}/bandbuddy-audio-host`))) {
    throw new Error(`MAC_AUDIO_HOST_ARCHITECTURE_MISSING:${architecture}`)
  }
  for (const binary of code.binaries) {
    const { stdout: slices } = await run('/usr/bin/lipo', ['-archs', binary])
    if (!slices.trim().split(/\s+/).includes(expected)) throw new Error(`MAC_BINARY_WRONG_ARCHITECTURE:${binary}:${slices.trim()}`)
    const { stdout: commands } = await run('/usr/bin/otool', ['-arch', expected, '-l', binary])
    const versions = deploymentTargets(commands)
    if (!versions.length || versions.some(version => {
      const [major, minor] = version.split('.').map(Number)
      return major > 13 || (major === 13 && minor > 0)
    })) throw new Error(`MAC_DEPLOYMENT_TARGET_EXCEEDS_13:${binary}:${versions.join(',')}`)
  }
  return { architecture, minimumSystemVersion: '13.0', binaries: code.binaries.length }
}

async function verifyApp(appPath, { notarized = false } = {}) {
  const app = path.resolve(appPath)
  const inventory = await scanCode(app)
  assertRequiredCode(app, inventory)
  const target = await verifyArchitecture(app, process.arch, inventory)
  for (const binary of inventory.binaries) {
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', publisherRequirement, binary])
    const { stderr } = await run('/usr/bin/codesign', ['--display', '--verbose=4', binary])
    if (!/flags=.*\bruntime\b/.test(stderr) || !/^Timestamp=/m.test(stderr)) {
      throw new Error(`MAC_SIGNATURE_REQUIREMENTS_MISSING:${path.relative(app, binary)}`)
    }
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', appRequirement, app])
  if (notarized) {
    await run('/usr/bin/xcrun', ['stapler', 'validate', app])
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  }
  return { app, ...target, binaries: inventory.binaries.map(file => path.relative(app, file)), bundles: inventory.bundles.length, notarized }
}

module.exports = { run, scanCode, selectIdentity, assertRequiredCode, verifyArchitecture, deploymentTargets, verifyApp, policy, publisherRequirement, appRequirement }
