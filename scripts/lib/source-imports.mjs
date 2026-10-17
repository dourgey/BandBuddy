// Node's TypeScript stripping leaves the source tree's .js specifiers intact.
// Resolve them to .ts only inside our shared source package, for DSP scripts.
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const sourceRoot = fileURLToPath(new URL('../../packages/shared/src/', import.meta.url))
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL?.startsWith('file:')
        && fileURLToPath(context.parentURL).startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
        const target = fileURLToPath(new URL(specifier, context.parentURL))
        if (!path.relative(sourceRoot, target).startsWith('..')) return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  }
})
