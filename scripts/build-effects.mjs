import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root = process.cwd()
const build = path.join(root, 'native/effects/build/wasm')
mkdirSync(build, { recursive: true })
writeFileSync(path.join(build, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.24)\nproject(Arsenal LANGUAGES C CXX)\nadd_subdirectory("${root}/native/effects" effects)\n`)
function run(cmd, args) { const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false }); if(r.error) throw r.error; if(r.status) process.exit(r.status) }
run('emcmake', ['cmake', '-S', build, '-B', path.join(build,'out'), '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', ...(process.env.NAM_SOURCE_DIR ? [`-DFETCHCONTENT_SOURCE_DIR_NAM_CORE=${process.env.NAM_SOURCE_DIR}`] : [])])
run('cmake', ['--build', path.join(build,'out'), '--parallel', '4'])
const dest=path.join(root,'src/renderer/src/arsenal/dsp')
mkdirSync(dest,{recursive:true})
for(const file of ['arsenal-dsp.js','arsenal-dsp.wasm']) copyFileSync(path.join(build,'out/effects',file),path.join(dest,file))
