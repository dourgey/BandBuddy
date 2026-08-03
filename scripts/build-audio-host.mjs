import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const target = `${process.platform}-${process.arch}`
const buildRoot = path.join(root, 'native', 'audio-host', 'build', target)
const outputRoot = path.join(root, 'resources', 'audio-host', target)
const executable = path.join(outputRoot, process.platform === 'win32' ? 'bandbuddy-audio-host.exe' : 'bandbuddy-audio-host')

function resolveCmakeExecutable() {
  if (process.env.CMAKE_EXECUTABLE) return process.env.CMAKE_EXECUTABLE
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['cmake'], {
    encoding: 'utf8',
    windowsHide: true
  })
  const fromPath = probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean) : undefined
  if (fromPath) return fromPath.trim()
  if (process.platform === 'win32') {
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
    const editions = ['BuildTools', 'Community', 'Professional', 'Enterprise']
    for (const base of programFiles) {
      for (const edition of editions) {
        const candidate = path.join(base, 'Microsoft Visual Studio', '2022', edition,
          'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe')
        if (existsSync(candidate)) return candidate
      }
    }
  }
  throw new Error(
    'CMake 3.24+ was not found. On Windows, install the Visual Studio 2022 "Desktop development with C++" workload and its CMake tools, or set CMAKE_EXECUTABLE.'
  )
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.env.BANDBUDDY_SKIP_AUDIO_HOST !== '1') {
  const cmake = resolveCmakeExecutable()
  mkdirSync(buildRoot, { recursive: true })
  mkdirSync(outputRoot, { recursive: true })
  const configureArgs = [
    '-S', path.join(root, 'native', 'audio-host'),
    '-B', buildRoot,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    `-DCMAKE_INSTALL_PREFIX=${outputRoot}`
  ]
  if (process.env.BANDBUDDY_GITHUB_PROXY) {
    configureArgs.push(`-DBANDBUDDY_GITHUB_PROXY=${process.env.BANDBUDDY_GITHUB_PROXY}`)
  }
  run(cmake, configureArgs)
  run(cmake, ['--build', buildRoot, '--config', 'Release', '--parallel'])
  // Install only our runtime. Some vendored projects register their own
  // install rules, which are neither required nor safe to package here.
  run(cmake, [
    '--install', buildRoot,
    '--config', 'Release',
    '--component', 'BandBuddyAudioHost'
  ])
  if (!existsSync(executable)) throw new Error(`Audio host was not installed at ${executable}`)
  run(executable, ['--self-test'])
  run(process.execPath, [path.join(root, 'scripts', 'test-audio-host.mjs'), executable])
}
