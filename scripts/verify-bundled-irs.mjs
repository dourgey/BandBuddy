import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const defaultRoot = path.resolve(import.meta.dirname, '../resources/cabinet-irs')
export function verifyBundledIrs(root = defaultRoot) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || !manifest.assets?.length) throw new Error('Missing bundled IR catalog')
  const ids = new Set(), files = new Set()
  let bytes = 0
  for (const asset of manifest.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.id) || ids.has(asset.id)) throw new Error(`Invalid or duplicate IR id: ${asset.name}`)
    if (!/^[a-z0-9-]+\/[a-zA-Z0-9_.-]+\.wav$/.test(asset.file) || files.has(asset.file)) throw new Error(`Invalid IR path: ${asset.file}`)
    ids.add(asset.id); files.add(asset.file)
    const content = readFileSync(path.join(root, asset.file))
    if (createHash('sha256').update(content).digest('hex') !== asset.id) throw new Error(`Bundled IR checksum mismatch: ${asset.file}`)
    if (content.toString('ascii', 0, 4) !== 'RIFF' || content.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`Invalid WAV: ${asset.file}`)
    if (asset.kind !== 'ir' || asset.bundled !== true || asset.metadata.sha256 !== asset.id || asset.metadata.processing !== 'original') throw new Error(`Invalid IR metadata: ${asset.file}`)
    const credit = asset.attribution
    const licenseUrl = credit?.license === 'CC0-1.0' ? 'https://creativecommons.org/publicdomain/zero/1.0/' : credit?.license === 'CC-BY-4.0' ? 'https://creativecommons.org/licenses/by/4.0/' : null
    if (!licenseUrl || credit.licenseUrl !== licenseUrl || !credit.author || !credit.credit || !credit.sourceUrl?.startsWith('https://') || !credit.changes) throw new Error(`Missing IR attribution: ${asset.file}`)
    for (const evidence of asset.metadata.licenseEvidence ?? []) {
      if (!/^licenses\/[\w.-]+$/.test(evidence) || !statSync(path.join(root, evidence)).isFile()) throw new Error(`Missing IR license evidence: ${evidence}`)
    }
    if (!asset.metadata.licenseEvidence?.length) throw new Error(`Missing IR license evidence: ${asset.file}`)
    bytes += content.length
  }
  const walk = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.relative(root, path.join(folder, entry.name)).replaceAll('\\', '/')])
  const extra = walk(root).filter(file => file.endsWith('.wav') && !files.has(file))
  if (extra.length) throw new Error(`Uncatalogued bundled WAVs: ${extra.join(', ')}`)
  for (const license of ['CC0-1.0.txt', 'CC-BY-4.0.txt']) if (readFileSync(path.join(root, 'licenses', license), 'utf8').length < 4000) throw new Error(`Incomplete license text: ${license}`)
  console.log(`Verified ${ids.size} bundled cabinet IRs (${(bytes / 1024 / 1024).toFixed(2)} MiB), checksums, sources and license evidence.`)
  return { count: ids.size, bytes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) verifyBundledIrs(process.argv[2])
