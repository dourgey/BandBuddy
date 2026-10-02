import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger } from '../src/main/logger.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('debug logger', () => {
  it('captures detailed logs only while debug mode is enabled', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-logger-'))
    temporaryRoots.push(root)
    const logger = new Logger(root)

    logger.info('before debug')
    expect(existsSync(logger.debugLogPath)).toBe(false)

    logger.setDebugMode(true)
    logger.info('during debug')
    logger.capture('error', 'renderer console', { error: new Error('render failed'), token: 'secret-value' })
    logger.setDebugMode(false)
    logger.warn('after debug')
    await logger.flush()

    const debugLog = readFileSync(logger.debugLogPath, 'utf8')
    expect(debugLog).toContain('debug mode enabled')
    expect(debugLog).toContain('during debug')
    expect(debugLog).toContain('renderer console')
    expect(debugLog).toContain('render failed')
    expect(debugLog).toContain('debug mode disabled')
    expect(debugLog).not.toContain('before debug')
    expect(debugLog).not.toContain('after debug')
    expect(debugLog).not.toContain('secret-value')

    const applicationLog = readFileSync(path.join(root, 'bandbuddy.log'), 'utf8')
    expect(applicationLog).toContain('before debug')
    expect(applicationLog).toContain('during debug')
    expect(applicationLog).toContain('after debug')
    expect(applicationLog).not.toContain('renderer console')
  })

  it('creates an empty debug log on demand so the app can open it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-logger-'))
    temporaryRoots.push(root)
    const logger = new Logger(root)

    expect(logger.ensureDebugLog()).toBe(path.join(root, 'debug.log'))
    expect(readFileSync(logger.debugLogPath, 'utf8')).toBe('')
  })

  it('bounds a burst of diagnostics and retains the newest context', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-logger-'))
    temporaryRoots.push(root)
    const logger = new Logger(root)
    for (let index = 0; index < 4000; index += 1) logger.info(`message-${index}`)
    await logger.flush()
    const lines = readFileSync(path.join(root, 'bandbuddy.log'), 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(2048)
    expect(lines.at(-1)).toContain('message-3999')
  })

  it('does not reject application work when the log directory is unavailable', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bandbuddy-logger-'))
    const logger = new Logger(root)
    rmSync(root, { recursive: true })
    logger.error('a disk failure must not hide the original error')
    await expect(logger.flush()).resolves.toBeUndefined()
  })
})
