import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const phases = ['window-visible', 'library-interactive', 'backend-ready']
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=')
  return [key, value.join('=')]
}))
const runs = Number(options.runs || 10)
const sizes = (options.sizes || '0,1000,10000').split(',').map(Number)
const selected = options.variant || 'both'
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || sizes.some(size => !Number.isInteger(size) || size < 0 || size > 100_000)
  || !['baseline', 'current', 'both'].includes(selected)) throw new Error('Usage: node scripts/benchmark-startup.mjs --variant=both --runs=10 --sizes=0,1000,10000 --output=report.json')
const variants = [
  { name: 'baseline', directory: path.resolve(root, options.baseline || '.codex-tmp/performance-baseline') },
  { name: 'current', directory: root }
].filter(variant => selected === 'both' || variant.name === selected)
const output = path.resolve(root, options.output || '.codex-tmp/startup-benchmark.json')
const workspace = await mkdtemp(path.join(os.tmpdir(), 'BandBuddy 启动基准 (独立数据) '))
const records = []
const bundles = {}

async function seed(directory, target, count) {
  await mkdir(path.join(target, 'appdata'), { recursive: true })
  // Extract only literal SQL templates; never execute application code or touch
  // the user's database while preparing benchmark fixtures.
  const source = await readFile(path.join(directory, 'src/main/database.ts'), 'utf8')
  const declaration = /export const DATABASE_MIGRATIONS = \[([\s\S]*?)\n\]/.exec(source)?.[1]
  const migrations = [...(declaration || '').matchAll(/`([^`]*)`/g)].map(match => match[1])
  if (!migrations.length || declaration.replace(/`[^`]*`/g, '').replace(/[\s,]/g, '') || migrations.some(sql => sql.includes('${') || sql.includes('\\'))) throw new Error(`Benchmark requires literal migration SQL: ${directory}`)
  const database = new DatabaseSync(path.join(target, 'appdata/bandbuddy.db'))
  try {
    database.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); BEGIN')
    const version = database.prepare('INSERT INTO schema_version VALUES (?, ?)')
    migrations.forEach((migration, index) => { database.exec(migration); version.run(index + 1, '2026-09-01T00:00:00Z') })
    const song = database.prepare(`INSERT INTO songs(id,title,artist,duration_ms,status,progress,active_separation_id,created_at,updated_at,last_practiced_at) VALUES (?,?,?,180000,'ready',1,?,?,?,?)`)
    const separation = database.prepare(`INSERT INTO separation_runs(id,song_id,model_name,model_revision,device,status,created_at,completed_at) VALUES (?,?,'htdemucs_6s','benchmark','cpu','completed',?,?)`)
    const stem = database.prepare('INSERT INTO stems(id,song_id,separation_id,type,rel_path,duration_ms,sample_rate,channels) VALUES (?,?,?,?,?,180000,44100,2)')
    const job = database.prepare(`INSERT INTO jobs(id,song_id,type,status,progress,created_at,finished_at) VALUES (?,?,'guitarSplit','completed',1,?,?)`)
    for (let index = 0; index < count; index++) {
      const id = randomUUID(), run = randomUUID(), date = new Date(1_750_000_000_000 + index * 1000).toISOString()
      song.run(id, `基准曲目 ${String(index).padStart(6, '0')}`, `Artist ${index % 40}`, run, date, date, index % 3 === 0 ? date : null)
      separation.run(run, id, date, date)
      for (const type of ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']) stem.run(randomUUID(), id, run, type, `${id}/${type}.flac`)
      if (index % 5 === 0) job.run(randomUUID(), id, date, date)
    }
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
  } finally { database.close() }
}

async function measure(variant, target) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, BANDBUDDY_BENCHMARK: '1', BANDBUDDY_TEST_ROOT: target }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'BANDBUDDY_SMOKE']) delete environment[key]
    const start = performance.now()
    const child = spawn(require('electron'), [variant.directory], { cwd: variant.directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const metrics = {}
    let partial = '', diagnostic = '', finished = false
    const timeout = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`Startup timeout: ${variant.name}; phases=${JSON.stringify(metrics)}\n${diagnostic}`)) }, 60_000)
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(metrics)
    }
    child.stdout.on('data', chunk => {
      partial += chunk.toString()
      const lines = partial.split(/\r?\n/)
      partial = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('BAND_BUDDY_METRIC ')) continue
        const metric = JSON.parse(line.slice('BAND_BUDDY_METRIC '.length))
        if (phases.includes(metric.phase) && metrics[metric.phase] === undefined) metrics[metric.phase] = Math.round((performance.now() - start) * 100) / 100
      }
    })
    child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + chunk.toString()).slice(-6000)
      if (diagnostic.includes('App threw an error during load') && /(?:Error|Exception):/.test(diagnostic)) {
        child.kill('SIGKILL')
        finish(new Error(`Application failed before startup: ${variant.name}\n${diagnostic}`))
      }
    })
    child.once('error', finish)
    child.once('close', (code, signal) => {
      if (code !== 0 || !phases.every(phase => Number.isFinite(metrics[phase]))) finish(new Error(`Startup failed (${code ?? signal}): ${variant.name}; phases=${JSON.stringify(metrics)}\n${diagnostic}`))
      else finish()
    })
  })
}

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b)
  if (fraction === 0.5 && sorted.length) return Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) * 50) / 100
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

async function save() {
  const summary = variants.flatMap(variant => sizes.map(songs => {
    const samples = records.filter(record => record.variant === variant.name && record.songs === songs && !record.warmup)
    return { variant: variant.name, songs, runs: samples.length, metrics: Object.fromEntries(phases.map(phase => [phase, {
      medianMs: percentile(samples.map(sample => sample.metrics[phase]), 0.5),
      p95Ms: percentile(samples.map(sample => sample.metrics[phase]), 0.95)
    }])) }
  }))
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, memoryGB: Math.round(os.totalmem() / 2 ** 30) }, methodology: 'Development Electron production builds; process spawn to phase arrival; one excluded warmup per variant and size; warm filesystem cache; fresh isolated Chinese-path database with migrations already applied per variant/size; six stems/song and one completed guitar job per five songs; missing Python/model runtime; no simulated audio files; results do not measure first install, migration latency or OS cold boot; median averages the two center samples, p95 uses nearest rank (maximum with 10 runs).', workspace, bundles, records, summary }, null, 2) + '\n')
}

for (const variant of variants) {
  const bundle = await readFile(path.join(variant.directory, 'out/main/index.js'))
  if (!bundle.includes(Buffer.from('BAND_BUDDY_METRIC')) || !bundle.includes(Buffer.from('backend-ready'))) throw new Error(`Build startup instrumentation first: ${variant.directory}`)
  bundles[variant.name] = { directory: variant.directory, mainSha256: createHash('sha256').update(bundle).digest('hex') }
}
for (const songs of sizes) {
  const targets = new Map()
  for (const variant of variants) {
    const target = path.join(workspace, `${variant.name}-${songs}`)
    await seed(variant.directory, target, songs)
    targets.set(variant.name, target)
  }
  // Interleave variants to reduce drift from host temperature and background load.
  for (let iteration = 0; iteration <= runs; iteration++) for (const variant of variants) {
    const metrics = await measure(variant, targets.get(variant.name))
    records.push({ variant: variant.name, songs, iteration, warmup: iteration === 0, metrics })
    await save()
    console.log(`${variant.name} songs=${songs} ${iteration === 0 ? 'warmup' : `run=${iteration}`} ${JSON.stringify(metrics)}`)
  }
}
console.log(`Startup benchmark saved: ${output}`)
