import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as buildVite, type Plugin } from 'vite'

const sharedAlias = resolve('packages/shared/src')
const mainDependencies = ['electron', ...Object.keys(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).dependencies)]

// Sandboxed Electron preloads cannot require relative chunks. Each preload is
// built as a self-contained entry, even when they share schemas or channels.
function lyricsPreload(): Plugin {
  return {
    name: 'bandbuddy-standalone-lyrics-preload',
    buildStart() {
      for (const file of ['src/preload/lyrics.ts', 'packages/shared/src/appearance.ts', 'packages/shared/src/channels.ts']) this.addWatchFile(resolve(file))
    },
    async writeBundle() {
      await buildVite({
        configFile: false,
        resolve: { alias: { '@shared': sharedAlias } },
        build: {
          target: 'node24', outDir: resolve('out/preload'), emptyOutDir: false, sourcemap: true, minify: false,
          lib: { entry: resolve('src/preload/lyrics.ts'), formats: ['cjs'], fileName: () => 'lyrics.cjs' },
          rollupOptions: { external: ['electron'], output: { codeSplitting: false } }
        }
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': sharedAlias } },
    build: { sourcemap: true, rollupOptions: { external: (id) => mainDependencies.some(name => id === name || id.startsWith(`${name}/`)), output: { format: 'es', entryFileNames: '[name].js' }, input: { index: resolve('src/main/index.ts'), 'analysis-worker': resolve('src/main/analysis-worker.ts'), 'database-boot-worker': resolve('src/main/database-boot-worker.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), lyricsPreload()],
    resolve: { alias: { '@shared': sharedAlias } },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        external: ['electron'],
        output: { codeSplitting: false, format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': sharedAlias } },
    plugins: [react(), tailwindcss()],
    build: {
      minify: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          lyrics: resolve('src/renderer/lyrics.html'),
          lan: resolve('src/renderer/lan.html')
        }
      }
    }
  }
})
