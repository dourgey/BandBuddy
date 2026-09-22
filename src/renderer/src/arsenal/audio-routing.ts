import type { AppSettings, RecordingAudioSettings } from '@shared/domain.js'
import type { BandBuddyApi } from '@shared/bridge.js'
import type { EffectChainSnapshot } from '@shared/arsenal.js'

/** Stop the old stream before persisting a configuration that requires a new native stream. */
export async function reconfigureArsenalAudio(
  api: Pick<BandBuddyApi, 'settings' | 'arsenal'>,
  edit: (current: RecordingAudioSettings) => RecordingAudioSettings,
  getChain: () => EffectChainSnapshot,
  isCurrent: () => boolean = () => true
): Promise<AppSettings> {
  const [latest, monitor] = await Promise.all([api.settings.get(), api.arsenal.monitorState()])
  if (!isCurrent()) return latest
  const next = edit(latest.recordingAudio)
  if (monitor.active) await api.arsenal.monitor({ mode: 'off', chain: getChain() })
  if (!isCurrent()) return latest
  const saved = await api.settings.reconcileAudio({
    expected: { audioOutputDeviceId: latest.audioOutputDeviceId, recordingAudio: latest.recordingAudio },
    audioOutputDeviceId: latest.audioOutputDeviceId,
    recordingAudio: next
  })
  // A settings window may have edited audio while enumeration or stream shutdown was in progress.
  if (JSON.stringify(saved.recordingAudio) !== JSON.stringify(next)) {
    throw new Error('音频设置已在其他窗口更新，请确认当前配置后重试。监听已关闭。')
  }
  if (monitor.active && isCurrent()) {
    const resumed = await api.arsenal.monitor({ mode: monitor.mode, chain: getChain() })
    if (!resumed.active || resumed.error) throw new Error(resumed.error ?? '监听未恢复，请检查音频设备后重新开启。')
  }
  return saved
}
