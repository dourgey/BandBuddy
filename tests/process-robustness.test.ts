import { describe, expect, it } from 'vitest'
import { runProcess } from '../src/main/process.js'

describe('managed process transport', () => {
  it('decodes UTF-8 across arbitrary pipe boundaries and flushes the final line', async () => {
    const lines: string[] = []
    const result = await runProcess(process.execPath, ['-e', `
      const bytes = Buffer.from(JSON.stringify({ path: '中文 空格/🎸.wav' }));
      const split = bytes.indexOf(Buffer.from('中')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
    `], { onStdoutLine: line => lines.push(line) })
    expect(JSON.parse(result.stdout).path).toBe('中文 空格/🎸.wav')
    expect(lines).toEqual([result.stdout])
  })

  it('bounds retained output while delivering all complete progress lines', async () => {
    let count = 0
    const result = await runProcess(process.execPath, ['-e', `for (let i = 0; i < 500; i++) console.log('progress ' + i + ' ' + 'x'.repeat(80));`], {
      maxOutputChars: 1024, onStdoutLine: () => count++
    })
    expect(count).toBe(500)
    expect(result.stdout.length).toBeLessThanOrEqual(1024)
    expect(result.stdout).toContain('progress 499')
  })

  it('never launches work for an already cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runProcess(process.execPath, ['-e', 'process.exit(42)'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('waits for cancellation to close the process and its pipes', async () => {
    const controller = new AbortController()
    const result = await runProcess(process.execPath, ['-e', `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`], {
      signal: controller.signal, killGraceMs: 30, onStdoutLine: () => controller.abort()
    })
    expect(result.code).not.toBe(0)
    expect(result.termination).toBe('cancelled')
  })

  it('times out a silent system probe', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50, killGraceMs: 30 })
    expect(result.code).not.toBe(0)
    expect(result.termination).toBe('timeout')
  })
  it('preserves spawn errors and distinguishes sleep interruption from cancellation', async () => {
    await expect(runProcess('does-not-exist-bandbuddy.exe', [])).rejects.toMatchObject({ code: 'PROCESS_SPAWN_FAILED', cause: { code: 'ENOENT' } })
    const controller = new AbortController()
    const result = await runProcess(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { signal: controller.signal, onStdoutLine: () => controller.abort({ code: 'SYSTEM_SUSPEND' }) })
    expect(result.termination).toBe('interrupted')
  })
})
