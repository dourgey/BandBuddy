export function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function gainLabel(db: number): string {
  if (db <= -60) return '−∞'
  const percent = Math.round(100 * 10 ** (db / 20))
  return `${db > 0 ? '+' : ''}${db.toFixed(db % 1 ? 1 : 0)} dB (${percent}%)`
}

export function statusLabel(status: string): string {
  return ({
    ready: '已完成', queued: '等待中', blockedRuntime: '等待环境', processing: '处理中',
    preparing: '准备中', separating: '分离中', postprocessing: '处理中', cancelling: '取消中',
    cancelled: '已取消', interrupted: '已中断', completed: '已完成', failed: '失败',
    missing: '未安装', detecting: '检测中', installing: '安装中', downloadingModel: '下载模型', verifying: '校验中'
  } as Record<string, string>)[status] ?? status
}

const USER_ERROR_MESSAGES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern: /SELECTED_INPUT_DEVICE_(?:MISSING|MESSING)|NO_AUDIO_INPUT_DEVICE/,
    message: '输入设备未就绪，请检查您的声卡'
  },
  {
    pattern: /SELECTED_OUTPUT_DEVICE_(?:MISSING|MESSING)|NO_AUDIO_OUTPUT_DEVICE|OUTPUT_STEREO_UNAVAILABLE/,
    message: '输出设备未就绪，请检查您的声卡'
  },
  {
    pattern: /MICROPHONE_PERMISSION_DENIED/,
    message: '麦克风权限未开启，请在系统设置中允许访问'
  },
  {
    pattern: /DEVICE_DISCONNECTED/,
    message: '音频设备连接已断开，请检查您的声卡'
  },
  {
    pattern: /INPUT_CHANNEL_CONFIGURATION_INVALID|INPUT_CHANNELS_INVALID|INPUT_CHANNEL_UNAVAILABLE|STEREO_INPUT_CHANNELS_MUST_BE_ADJACENT/,
    message: '输入通道不可用，请在设置中重新选择'
  },
  {
    pattern: /NO_COMMON_SAMPLE_RATE|SELECTED_SAMPLE_RATE_UNAVAILABLE|BACKING_SAMPLE_RATE_MISMATCH|AUDIO_SAMPLE_RATE_CHANGED/,
    message: '当前采样率不可用，请在设置中选择“自动”'
  },
  {
    pattern: /AUDIO_INPUT_(?:OPEN|START|STATE_HANDLER)_FAILED/,
    message: '无法打开输入设备，请检查声卡连接、占用或权限'
  },
  {
    pattern: /AUDIO_OUTPUT_(?:OPEN|START|STATE_HANDLER)_FAILED/,
    message: '无法打开输出设备，请检查声卡连接或占用'
  },
  {
    pattern: /AUDIO_(?:OPEN|START|STATE_HANDLER)_FAILED|AUDIO_DRIVER_ERROR|AUDIO_STREAM_INFO_MISSING|PORTAUDIO_INITIALIZE_FAILED|WASAPI_HOST_API_MISSING/,
    message: '音频设备启动失败，请检查声卡后重试'
  },
  {
    pattern: /AUDIO_HOST_(?:EXITED|TIMEOUT|ERROR)/,
    message: '录音组件未响应，请重启应用后重试'
  },
  {
    pattern: /AUDIO_HOST_MISSING|FFMPEG_MISSING|TOOL_MANIFEST_ROLE_MISSING/,
    message: '音频组件缺失，请重新安装或修复应用'
  },
  {
    pattern: /CAPTURE_(?:OPEN_FAILED|WRITE_OVERFLOW)|RECORDING_CAPTURE_EMPTY|RECORDING_(?:BACKING|SOURCE_ENCODE|PREVIEW)_FAILED|BACKING_(?:OPEN_FAILED|WAV_INVALID|WAV_FORMAT_UNSUPPORTED|STREAM_(?:PRIME_FAILED|UNDERRUN))/,
    message: '录音处理失败，请检查磁盘空间后重试'
  },
  {
    pattern: /RECORDING_SESSION_BUSY/,
    message: '已有录音任务正在进行'
  },
  {
    pattern: /RECORDING_RANGE_TOO_SHORT/,
    message: '可录制时长太短，请调整播放位置或循环范围'
  },
  {
    pattern: /REHEARSAL_EMPTY/,
    message: '编排单为空，请先加入歌曲或衔接'
  },
  {
    pattern: /REHEARSAL_HAS_UNAVAILABLE_SONGS/,
    message: '编排中有不可用歌曲，请先移除或替换'
  },
  {
    pattern: /REHEARSAL_(?:NOT_FOUND|REVISION_NOT_FOUND|RECORDING_TRACK_NOT_FOUND|RECORDING_TAKE_NOT_FOUND)/,
    message: '编排单或录音已不存在，请刷新后重试'
  },
  {
    pattern: /SONG_NOT_READY|RECORDING_SONG_MISMATCH/,
    message: '歌曲尚未准备好，暂时无法录音'
  },
  {
    pattern: /RECORDING_TRACK_CREATE_FAILED/,
    message: '无法创建录音轨，请重试'
  },
  {
    pattern: /RECORDING_TRACK_NOT_FOUND|RECORDING_TAKE_NOT_FOUND/,
    message: '录音轨或 Take 已不存在，请刷新后重试'
  },
  {
    pattern: /RECORDING_TAKE_SPEED_MISMATCH/,
    message: '录音速度与当前速度不一致，请切回录制时的速度'
  },
  {
    pattern: /ACTIVE_RECORDING_TAKE_MISSING/,
    message: '所选录音已不存在，请刷新后重试'
  },
  {
    pattern: /NO_AUDIBLE_TRACKS/,
    message: '没有可导出的声音，请先取消静音至少一条音轨'
  },
  {
    pattern: /NO_STEMS_TO_EXPORT/,
    message: '当前歌曲没有可导出的音轨'
  },
  {
    pattern: /EXPORT_PATH_REQUIRED/,
    message: '请选择导出位置'
  },
  {
    pattern: /NO_AVAILABLE_EXPORT_NAME/,
    message: '无法生成可用的导出文件名，请更换位置后重试'
  },
  {
    pattern: /EXPORT_SERVICE_NOT_READY|EXPORT_FAILED/,
    message: '导出失败，请检查磁盘空间后重试'
  },
  {
    pattern: /UNSUPPORTED_AUDIO_FORMAT/,
    message: '暂不支持这种音频格式'
  },
  {
    pattern: /UNSUPPORTED_LYRICS_FORMAT/,
    message: '请选择 .lrc 格式的歌词文件'
  },
  {
    pattern: /LYRICS_FILE_TOO_LARGE/,
    message: '歌词文件过大，请选择小于 2 MB 的 LRC 文件'
  },
  {
    pattern: /LYRICS_FILE_EMPTY|LRC_NO_TIMESTAMPS/,
    message: '没有读取到带时间标签的歌词，请检查 LRC 文件'
  },
  {
    pattern: /EMPTY_AUDIO_FILE|NO_AUDIO_STREAM|EMPTY_NCM_AUDIO/,
    message: '音频文件为空或无法读取'
  },
  {
    pattern: /SOURCE_COPY_HASH_MISMATCH|AUDIO_PROBE_FAILED|AUDIO_CONVERSION_FAILED|AUDIO_DECODE_FAILED|NORMALIZE_FAILED|PEAKS_FAILED|INVALID_NCM_|NCM_OUTPUT_WRITE_FAILED/,
    message: '音频文件处理失败，请检查文件是否完整'
  },
  {
    pattern: /ORIGINAL_SOURCE_NOT_AVAILABLE|SOURCE_FILE_MISSING/,
    message: '原始音频文件已不存在'
  },
  {
    pattern: /AT_LEAST_TWO_STEMS_REQUIRED/,
    message: '至少需要两条已分类音轨'
  },
  {
    pattern: /DUPLICATE_STEM_TYPE/,
    message: '每种音轨类型只能选择一次'
  },
  {
    pattern: /SONG_NOT_FOUND|JOB_SONG_MISSING/,
    message: '歌曲不存在或已被删除'
  },
  {
    pattern: /CUDA_OOM/,
    message: '显存不足，可使用 CPU 重试'
  },
  {
    pattern: /CUDA_NOT_AVAILABLE|MPS_NOT_AVAILABLE/,
    message: '所选计算设备不可用，将尝试使用 CPU'
  },
  {
    pattern: /DISK_FULL|NO SPACE LEFT ON DEVICE/i,
    message: '磁盘空间不足，请清理后重试'
  },
  {
    pattern: /MODEL_(?:HASH_MISMATCH|MARKER_MISSING|MARKER_INVALID|MARKER_MISMATCH|BAG_MISSING_OR_CHANGED|FILE_MISSING)/,
    message: '模型文件损坏或不完整，请清理模型缓存后重试'
  },
  {
    pattern: /MODEL_DOWNLOAD_FAILED|INCOMPLETE_DOWNLOAD|UV_DOWNLOAD_HTTP_/,
    message: '下载失败，请检查网络后重试'
  },
  {
    pattern: /MODEL_INSTALL_FAILED|UV_FAILED|UV_HASH_MISMATCH|UV_ARCHIVE_INVALID|UV_EXTRACT_FAILED|PYTHON_MISSING|SELF_TEST_FAILED|TORCH_SELF_TEST_FAILED|MODEL_SELF_TEST_/,
    message: '运行环境异常，请尝试修复或重新安装'
  },
  {
    pattern: /SEPARATION_FAILED|WORKER_(?:FAILED|ERROR)|INCOMPLETE_STEM_OUTPUT|UNEXPECTED_STEMS|EMPTY_STEM/,
    message: '分轨处理失败，请重试'
  },
  {
    pattern: /APP_INTERRUPTED/,
    message: '应用上次提前退出，任务已中断，可点击重试'
  },
  {
    pattern: /PATH_OUTSIDE_MANAGED_ROOT|ABSOLUTE_LIBRARY_PATH_REJECTED|UNSAFE_(?:RUNTIME|MODEL)_PATH/,
    message: '所选存储位置不可用，请重新选择'
  },
  {
    pattern: /UNTRUSTED_IPC_(?:SENDER|ORIGIN)|INVALID_(?:SONG|JOB)_ID/,
    message: '请求未能完成，请重启应用后重试'
  }
]

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

function stripErrorWrapper(value: string): string {
  let message = value.trim().replace(/^Error:\s*/i, '')
  message = message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '')
  return message.replace(/^Error:?\s*/i, '').trim()
}

export function isCancellationError(error: unknown): boolean {
  return /\b(?:[A-Z][A-Z0-9]*_)*CANCELLED\b|AbortError/i.test(errorText(error))
}

export function toUserErrorMessage(error: unknown, fallback = '操作失败，请重试'): string {
  const raw = errorText(error)
  const known = USER_ERROR_MESSAGES.find(({ pattern }) => pattern.test(raw))
  if (known) return known.message

  const message = stripErrorWrapper(raw)
  const isShortChineseMessage = message.length <= 120
    && !message.includes('\n')
    && /[\u3400-\u9fff]/u.test(message)
    && !/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(message)
  return isShortChineseMessage ? message : fallback
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
