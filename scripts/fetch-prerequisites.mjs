import { mkdir, rename, rm } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
const directory=path.resolve('resources/prerequisites')
await mkdir(directory,{recursive:true})
if(process.platform==='win32') {
  const helper=path.resolve('resources/system-helper/win32-x64/bandbuddy-system-helper.exe')
  const file=path.join(directory,'vc_redist.x64.exe')
  const valid=file=>{const r=spawnSync(helper,['signature',file],{encoding:'utf8',windowsHide:true});try{const s=JSON.parse(r.stdout);return r.status===0&&s.status==='Valid'&&/(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)/.test(s.subject)}catch{return false}}
  if(!existsSync(file)||!valid(file)) {
    const temporary=file+'.part'
    try {
      const response=await fetch('https://aka.ms/vc14/vc_redist.x64.exe',{signal:AbortSignal.timeout(120000)})
      if(!response.ok||!response.body)throw new Error(`VC_RUNTIME_DOWNLOAD_HTTP_${response.status}`)
      await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary))
      if(!valid(temporary))throw new Error('VC_RUNTIME_SIGNATURE_INVALID')
      await rename(temporary,file)
    }finally{await rm(temporary,{force:true})}
  }
  console.log('Verified Microsoft runtime prerequisite')
}
