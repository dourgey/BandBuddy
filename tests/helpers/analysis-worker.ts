import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

let compiled: Promise<{ root: string; url: URL }> | null = null

/** Compile the real worker into an isolated temp folder, independent of out/. */
export async function testAnalysisWorker(): Promise<URL> {
  compiled ??= (async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bandbuddy-analysis-test-'))
    await build({ configFile: false, logLevel: 'silent',
      resolve: { alias: { '@shared': path.resolve('packages/shared/src') } },
      build: { ssr: path.resolve('src/main/analysis-worker.ts'), outDir: root, emptyOutDir: false,
        rollupOptions: { output: { format: 'es', entryFileNames: 'analysis-worker.mjs' } }
      }
    })
    return { root, url: pathToFileURL(path.join(root, 'analysis-worker.mjs')) }
  })()
  return (await compiled).url
}

export async function removeTestAnalysisWorker(): Promise<void> {
  if (compiled) await rm((await compiled).root, { recursive: true, force: true })
  compiled = null
}
