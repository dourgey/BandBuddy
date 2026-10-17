const { run, scanCode, selectIdentity, assertRequiredCode, verifyApp } = require('./macos-signing.cjs')
const path = require('node:path')

module.exports = async function signMacApp(options) {
  if (process.platform !== 'darwin' || options.platform !== 'darwin') throw new Error('MAC_SIGNING_REQUIRES_MACOS')
  const keychainArgs = options.keychain ? [options.keychain] : []
  const { stdout } = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...keychainArgs])
  // electron-builder already resolves its selected identity to a fingerprint.
  // Passing that fingerprint avoids ambiguity between same-name certificates.
  const identity = selectIdentity(stdout, process.env.BANDBUDDY_MAC_SIGN_IDENTITY || options.identity)
  const inventory = await scanCode(options.app)
  assertRequiredCode(options.app, inventory)
  console.log(`Signing ${inventory.binaries.length} Mach-O files and ${inventory.bundles.length} bundles with ${identity.hash}`)
  // Sign actual code once, then containers from the inside out. Plain resource
  // files (.pak, Python, JSON, model metadata) are sealed by the outer app.
  for (const file of [...inventory.binaries, ...inventory.bundles]) {
    const perFile = options.optionsForFile ? await options.optionsForFile(file) : {}
    if (perFile.hardenedRuntime === false) throw new Error('MAC_HARDENED_RUNTIME_REQUIRED')
    const args = ['--force', '--sign', identity.hash, '--timestamp', '--options', 'runtime']
    if (options.keychain) args.push('--keychain', options.keychain)
    const entitlements = path.basename(file) === 'bandbuddy-plugin-host'
      ? path.resolve(__dirname, '../build/entitlements.plugin-host.mac.plist') : perFile.entitlements
    if (entitlements) args.push('--entitlements', entitlements)
    if (perFile.requirements) args.push('--requirements', perFile.requirements)
    args.push(file)
    await run('/usr/bin/codesign', args)
  }
  await verifyApp(options.app)
}
