import { describe, expect, it } from 'vitest'
import { DiagnosticError } from '../src/main/diagnostic-errors.js'
import { environmentIssue } from '../src/main/environment-issues.js'

describe('native process failure guidance', () => {
  it.each([3221225477, -1073741819])('identifies access violation %s without diagnosing CPU incompatibility', exitCode => {
    const result = environmentIssue(new DiagnosticError('AUDIO_HOST_EXITED', `AUDIO_HOST_EXITED:${exitCode}`, { exitCode }), 'recording')
    expect(result).toMatchObject({ code: 'NATIVE_ACCESS_VIOLATION', action: 'audio', confidence: 'unknown' })
    expect(result.message).toContain('0xC0000005')
    expect(result.nextSteps?.join()).not.toContain('CPU')
    expect(result.evidence?.details?.exitCode).toBe(exitCode)
  })
  it('recognizes structured access-violation evidence forwarded by the audio supervisor', () => {
    const error = new DiagnosticError('AUDIO_DRIVER_PROBE_FAILED', 'ASIO 探测失败', {},
      new DiagnosticError('AUDIO_HOST_EXITED', '进程退出', { exception: 'ACCESS_VIOLATION' }))
    expect(environmentIssue(error, 'recording').code).toBe('NATIVE_ACCESS_VIOLATION')
  })
  it('keeps illegal-instruction compatibility guidance distinct from memory errors', () => {
    expect(environmentIssue(new Error('NATIVE_CRASH:3221225501'), 'recording')).toMatchObject({ code: 'NATIVE_ILLEGAL_INSTRUCTION', action: 'repairApplication' })
  })
  it('does not assume the cause of another audio process exit', () => {
    const result = environmentIssue(new Error('AUDIO_HOST_EXITED:1'), 'recording')
    expect(result).toMatchObject({ code: 'NATIVE_PROCESS_FAILED', action: 'audio', confidence: 'unknown' })
    expect(result.nextSteps?.join()).not.toContain('CPU')
  })
})
