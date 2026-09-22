const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { mkdtemp, readdir, rm, mkdir, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { run, verifyApp, publisherRequirement, policy } = require('./macos-signing.cjs')

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function smokeApp(app, directory) {
  const { stdout } = await run(path.join(app, 'Contents/MacOS', policy.productName), [], {
    cwd: directory, timeout: 45_000,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', BANDBUDDY_SMOKE: '1', BANDBUDDY_TEST_ROOT: directory }
  })
  const line = stdout.split(/\r?\n/).find(line => line.startsWith('BAND_BUDDY_SMOKE '))
  const result = line ? JSON.parse(line.slice('BAND_BUDDY_SMOKE '.length)) : null
  if (result?.apiType !== 'object' || !result.ffmpegReady) throw new Error('MAC_PACKAGED_SMOKE_FAILED')
  return result
}

async function verifyRelease(context) {
  if (process.platform !== 'darwin') throw new Error('MAC_VERIFICATION_REQUIRES_MACOS')
  const outDir = path.resolve(context.outDir)
  const notarized = context.configuration?.mac?.notarize === true
  const report = { notarized, apps: [], artifacts: [], smoke: null }
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^mac(?:-|$)/.test(entry.name)) continue
    report.apps.push(await verifyApp(path.join(outDir, entry.name, `${policy.productName}.app`), { notarized }))
  }
  if (!report.apps.length) throw new Error('MAC_PACKAGED_APP_MISSING')
  const artifacts = (context.artifactPaths || []).filter(file => /\.(dmg|zip)$/.test(file))
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'bandbuddy-release-verify-'))
  try {
    for (const [index, file] of artifacts.entries()) {
      const directory = path.join(temporary, `artifact-${index}`)
      await mkdir(directory)
      let mounted = false
      try {
        if (file.endsWith('.dmg')) {
          await run('/usr/bin/codesign', ['--verify', '--strict', '-R', publisherRequirement, file])
          await run('/usr/bin/hdiutil', ['verify', file])
          await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', directory, file])
          mounted = true
        } else {
          await run('/usr/bin/ditto', ['-x', '-k', file, directory])
        }
        const app = path.join(directory, `${policy.productName}.app`)
        const verified = await verifyApp(app, { notarized })
        if (file.endsWith('.zip')) {
          const smokeRoot = path.join(temporary, 'smoke')
          await mkdir(smokeRoot, { recursive: true })
          report.smoke = await smokeApp(app, smokeRoot)
        }
        report.artifacts.push({ file: path.basename(file), sha256: await sha256(file), binaries: verified.binaries.length })
      } finally {
        if (mounted) await run('/usr/bin/hdiutil', ['detach', directory])
      }
    }
    if (!artifacts.length) {
      const smokeRoot = path.join(temporary, 'smoke')
      await mkdir(smokeRoot)
      report.smoke = await smokeApp(report.apps[0].app, smokeRoot)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
  await writeFile(path.join(outDir, `SIGNATURE-REPORT-macos-${process.arch}.json`), `${JSON.stringify(report, null, 2)}\n`)
  if (artifacts.length) {
    await writeFile(path.join(outDir, `SHA256SUMS-macos-${process.arch}.txt`), report.artifacts.map(artifact => `${artifact.sha256}  ${artifact.file}\n`).join(''))
  }
  console.log(`Verified ${report.apps[0].binaries.length} signed Mach-O files, ${artifacts.length} distribution artifacts and isolated startup.`)
  return []
}

module.exports = verifyRelease
if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || 'release-macos')
  readdir(outDir).then(files => verifyRelease({
    outDir, artifactPaths: files.filter(file => /\.(dmg|zip)$/.test(file)).map(file => path.join(outDir, file)),
    configuration: { mac: { notarize: process.argv.includes('--notarized') } }
  })).catch(error => { console.error(error.message); process.exitCode = 1 })
}
