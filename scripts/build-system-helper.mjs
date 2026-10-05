import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
mkdirSync(path.join(process.cwd(), 'resources/system-helper'), { recursive: true })
if (process.platform === 'win32') {
  const candidates = [process.env.CMAKE_EXECUTABLE, 'C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe', 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe']
  const cmake = candidates.find(value => value && existsSync(value)) ?? 'cmake'
  const root = process.cwd(), build = path.join(root, 'native/system-helper/build'), output = path.join(root, 'resources/system-helper/win32-x64')
  mkdirSync(output, { recursive: true })
  const run = (command, args) => { const result=spawnSync(command,args,{stdio:'inherit',windowsHide:true}); if(result.error)throw result.error; if(result.status)process.exit(result.status) }
  run(cmake,['-S',path.join(root,'native/system-helper'),'-B',build,'-A','x64',`-DCMAKE_INSTALL_PREFIX=${output}`])
  run(cmake,['--build',build,'--config','Release'])
  run(cmake,['--install',build,'--config','Release'])
  run(path.join(output,'bandbuddy-system-helper.exe'),['self-test'])
}
