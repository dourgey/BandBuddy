const path = require('node:path')
const { verifyArchitecture } = require('./macos-signing.cjs')

if (process.platform !== 'darwin') throw new Error('MAC_ARCHITECTURE_VERIFICATION_REQUIRES_MACOS')
if (!process.argv[2]) throw new Error('Pass the packaged .app path')
verifyArchitecture(path.resolve(process.argv[2]), process.argv[3] || process.arch)
  .then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.message); process.exitCode = 1 })
