import { normalizeAppearance, resolveTheme } from '@shared/appearance.js'
import type { BandBuddyApi } from '@shared/bridge.js'
import type { StartupState } from '@shared/startup.js'

/** Mounts React only after all service handlers exist; the static shell stays useful meanwhile. */
export async function startRenderer(api: BandBuddyApi | undefined, mount: () => Promise<void>): Promise<void> {
  const status = document.getElementById('startup-status')
  const detail = document.getElementById('startup-detail')
  const error = document.getElementById('startup-error')
  let loading = false
  let disposed = false
  let revision = 0
  let unsubscribe = (): void => {}
  const paint = (state: StartupState): void => {
    const appearance = normalizeAppearance(state.appearance)
    const root = document.documentElement
    root.dataset.theme = resolveTheme(appearance, typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
    root.dataset.themeMode = appearance.theme
    root.dataset.density = appearance.density
    root.dataset.effects = appearance.effects
    root.style.colorScheme = root.dataset.theme === 'dark' ? 'dark' : 'light'
    if (status) status.textContent = state.message
    if (detail && state.phase === 'failed') detail.textContent = '启动未完成，曲库尚未打开。请关闭后重试；若仍失败，请保留已有数据库和备份文件。'
    if (error) { error.hidden = state.phase !== 'failed'; error.textContent = state.error ?? '' }
  }
  const receive = (state: StartupState): void => {
    if (disposed) return
    revision++
    paint(state)
    if (state.phase !== 'ready' || loading) return
    loading = true
    void mount().then(() => { disposed = true; unsubscribe() }).catch(reason => {
      loading = false
      paint({ ...state, phase: 'failed', message: '界面加载失败，请关闭后重新打开。', error: reason instanceof Error ? reason.message : String(reason) })
    })
  }
  document.querySelector('[data-startup-minimize]')?.addEventListener('click', () => void api?.window.minimize())
  document.querySelector('[data-startup-close]')?.addEventListener('click', () => void api?.window.close())
  if (!api) {
    paint({ phase: 'failed', appearance: normalizeAppearance(null), message: '无法连接桌面服务。', error: '请使用 BandBuddy 桌面应用打开；开发预览请启用 fixtures。' })
    return
  }
  if (!api.startup) { await mount(); return }
  receive(api.startup.snapshot())
  unsubscribe = api.startup.onChanged(receive)
  const requestRevision = revision
  void api.startup.get().then(state => { if (revision === requestRevision) receive(state) }).catch(reason => {
    if (revision === requestRevision) receive({ phase: 'failed', appearance: api.startup!.snapshot().appearance, message: '无法获取启动状态，请重新打开应用。', error: String(reason) })
  })
  // This is an actual painted shell, not a timer approximating visibility.
  requestAnimationFrame(() => requestAnimationFrame(() => void api.startup?.painted()))
}
