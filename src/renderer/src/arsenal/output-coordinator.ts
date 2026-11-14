import { requiresBrowserOutputHandoff } from '@shared/arsenal.js'

export const nativeOutputRoutes=new Set<{prepare():Promise<void>;restore():Promise<void>}>()
export async function prepareNativeOutput():Promise<void>{
  if (!nativeOutputRoutes.size) return
  const settings = window.bandbuddy?.settings?.get ? await window.bandbuddy.settings.get() : null
  // Preserve the browser device/session and its volume in shared mode. Only
  // exclusive drivers require releasing it before opening input monitoring.
  if (settings && !requiresBrowserOutputHandoff(settings.recordingAudio.backend)) return
  await Promise.all([...nativeOutputRoutes].map(route=>route.prepare()))
}
export async function restoreBrowserOutput():Promise<void>{await Promise.all([...nativeOutputRoutes].map(route=>route.restore()))}
