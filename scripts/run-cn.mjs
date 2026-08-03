import { spawnSync } from 'node:child_process'

const [script = 'install', ...args] = process.argv.slice(2)
const registry = 'https://registry.npmmirror.com'
const env = {
  ...process.env,
  pnpm_config_registry: registry,
  npm_config_registry: registry,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  npm_config_electron_mirror: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  npm_config_better_sqlite3_binary_host: 'https://cdn.npmmirror.com/binaries/better-sqlite3',
  npm_config_better_sqlite3_binary_host_mirror: 'https://cdn.npmmirror.com/binaries/better-sqlite3',
  BANDBUDDY_GITHUB_PROXY: process.env.BANDBUDDY_GITHUB_PROXY ?? 'https://ghfast.top/'
}

const pnpmArgs = script === 'install' ? ['install', ...args] : ['run', script, ...args]
console.log(`Running pnpm ${pnpmArgs.join(' ')} with mainland China mirrors (limited to this command)...`)
let result
if (process.platform === 'win32') {
  // Node 24 no longer launches .cmd shims directly. Pass arguments as JSON so
  // PowerShell can invoke pnpm.cmd without interpolating them into shell code.
  const powershell = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$pnpmArgs = @((ConvertFrom-Json -InputObject $env:BANDBUDDY_PNPM_ARGS))',
    '& pnpm.cmd @pnpmArgs',
    'exit $LASTEXITCODE'
  ].join('\n')
  const encodedCommand = Buffer.from(powershell, 'utf16le').toString('base64')
  result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encodedCommand], {
    cwd: process.cwd(),
    env: { ...env, BANDBUDDY_PNPM_ARGS: JSON.stringify(pnpmArgs) },
    stdio: 'inherit'
  })
} else {
  result = spawnSync('pnpm', pnpmArgs, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit'
  })
}

if (result.error) throw result.error
process.exit(result.status ?? 1)
