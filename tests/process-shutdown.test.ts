import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { shutdownProcesses, spawnSafe } from '../src/main/process.js'

describe('application subprocess shutdown', () => {
  it('waits for managed processes to close and prevents new work during exit', async () => {
    const child = spawnSafe(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { killGraceMs: 25 })
    await once(child.stdout, 'data')
    let closed = false
    child.once('close', () => { closed = true })
    await shutdownProcesses()
    expect(closed).toBe(true)
    expect(() => spawnSafe(process.execPath, ['-e', 'process.exit(0)'])).toThrow('APPLICATION_SHUTTING_DOWN')
    await shutdownProcesses()
  })
})
