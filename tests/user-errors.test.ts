import { describe, expect, it } from 'vitest'
import { isCancellationError, toUserErrorMessage } from '../src/renderer/src/utils.js'

describe('user-facing error messages', () => {
  it('turns wrapped input device errors into a concise prompt', () => {
    expect(toUserErrorMessage(
      "Error invoking remote method 'recording:start': Error SELECTED_INPUT_DEVICE_MESSING"
    )).toBe('输入设备未就绪，请检查您的声卡')
    expect(toUserErrorMessage(
      "Error: Error invoking remote method 'recording:start': Error: SELECTED_INPUT_DEVICE_MISSING"
    )).toBe('输入设备未就绪，请检查您的声卡')
  })

  it('maps other actionable codes without exposing diagnostics', () => {
    expect(toUserErrorMessage('Error: MICROPHONE_PERMISSION_DENIED')).toBe('麦克风权限未开启，请在系统设置中允许访问')
    expect(toUserErrorMessage('Error: CUDA_OOM_CPU_RETRY_AVAILABLE')).toBe('显存不足，可使用 CPU 重试')
    expect(toUserErrorMessage('Error: UNKNOWN_BACKEND_FAILURE:C:\\private\\debug.log', '录音失败，请重试')).toBe('录音失败，请重试')
  })

  it('keeps deliberate Chinese validation messages and detects cancellations', () => {
    expect(toUserErrorMessage('Error: 请先选择一首歌曲')).toBe('请先选择一首歌曲')
    expect(isCancellationError("Error invoking remote method 'recording:start': Error: RECORDING_CANCELLED")).toBe(true)
  })
})
