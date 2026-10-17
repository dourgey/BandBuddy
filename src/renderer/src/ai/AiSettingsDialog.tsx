import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, Eye, EyeOff, LoaderCircle, Save, Sparkles, Unplug, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_AI_SETTINGS, type AiSettings, type AiSettingsInput, type AiSettingsView } from '@shared/ai.js'
import { aiCompletionUrl, aiSettingsInputSchema } from '@shared/ai-schema.js'
import { aiUiError as toUserErrorMessage } from './errors.js'
import './ai.css'

export function AiSettingsDialog({ open, onOpenChange, trigger = false }: { open: boolean; onOpenChange(open: boolean): void; trigger?: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState<AiSettings>({ ...DEFAULT_AI_SETTINGS })
  const [hasToken, setHasToken] = useState(false)
  const [verified, setVerified] = useState(false)
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<'save' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [loadVersion, setLoadVersion] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const apply = (value: AiSettingsView): void => { setDraft({ ...DEFAULT_AI_SETTINGS, baseUrl: value.settings.baseUrl, model: value.settings.model }); setHasToken(value.hasToken); setVerified(value.verified); setToken(''); setClearToken(false); setShowToken(false) }
  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true); setLoaded(false); setError(''); setStatus('')
    const api = window.bandbuddy.ai
    if (!api) { setError('AI 服务不可用，请使用新版桌面应用。'); setLoading(false); return }
    void api.getSettings().then(value => { if (live) { apply(value); setLoaded(true) } }, reason => { if (live) setError(toUserErrorMessage(reason, '读取 AI 设置失败')) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [open, loadVersion])
  const patch = <K extends keyof AiSettings>(key: K, value: AiSettings[K]): void => { setDraft(current => ({ ...current, [key]: value })); setVerified(false); setStatus(''); setError('') }
  const execute = async (mode: 'save' | 'test'): Promise<void> => {
    const input: AiSettingsInput = { settings: draft, ...(clearToken ? { token: null } : token.trim() ? { token: token.trim() } : {}) }
    const parsed = aiSettingsInputSchema.safeParse(input)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '请检查设置。'); return }
    const api = window.bandbuddy.ai
    if (!api) return
    setWorking(mode); setError(''); setStatus('')
    try {
      if (mode === 'save') { const value = await api.saveSettings(parsed.data); apply(value); setStatus(value.verified ? 'AI 设置已保存。' : 'AI 设置已保存，可点击检验配置确认是否可用。') }
      else { const result = await api.testSettings(parsed.data); apply(await api.getSettings()); setStatus(`检验通过，配置已保存并启用 · ${(result.elapsedMs / 1000).toFixed(1)} 秒。`) }
    } catch (reason) { setVerified(false); setError(toUserErrorMessage(reason, mode === 'save' ? '保存失败，请重试' : '配置检验失败')) }
    finally { setWorking(null) }
  }
  let endpoint = ''
  try { if (draft.baseUrl) endpoint = aiCompletionUrl(draft.baseUrl) } catch { /* Validation is displayed on save/test. */ }
  return <Dialog.Root open={open} onOpenChange={next => { if (!working) onOpenChange(next) }}>
    {trigger && <Dialog.Trigger className="settings-category" aria-label="AI 对话设置"><span className="settings-category-icon"><Sparkles /></span><span className="settings-category-copy"><b>AI 对话</b><small>Base URL、Token / API Key、模型名</small><em>OpenAI 兼容接口 · 图文对话</em></span><ChevronRight size={18} /></Dialog.Trigger>}
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay settings-detail-overlay" data-dialog-open="true" />
      <Dialog.Content className="dialog-content settings-detail ai-settings" data-dialog-open="true" onKeyDown={event => event.stopPropagation()} onInteractOutside={event => event.preventDefault()}>
        <header className="settings-detail-header"><Dialog.Title>AI 对话设置</Dialog.Title><Dialog.Description>实验室功能 · 连接你选择的 OpenAI 兼容模型服务。</Dialog.Description></header>
        <Dialog.Close className="dialog-close" aria-label="关闭 AI 设置" disabled={!!working}><X /></Dialog.Close>
        <div className="settings-detail-scroll">
          {loading && <p role="status">正在读取设置…</p>}
          <fieldset disabled={loading || !!working || !loaded}>
            <section className="settings-section"><h3><Sparkles />模型服务</h3>
              <label>Base URL<input type="url" value={draft.baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} onChange={event => patch('baseUrl', event.target.value)} /></label>
              <p className="ai-field-note">填写服务商提供的 API 根地址，可包含 /v1。{endpoint && <span className="ai-endpoint">请求地址：{endpoint}</span>}</p>
              <label>Token / API Key<span className="ai-token-input"><input type={showToken ? 'text' : 'password'} value={token} disabled={clearToken} autoComplete="off" spellCheck={false} placeholder={hasToken && !clearToken ? '已保存 Token，留空可保留' : '无需认证的本地服务可留空'} onChange={event => { setToken(event.target.value); setVerified(false); setError(''); setStatus('') }} /><button type="button" className="ai-icon-button" aria-label={showToken ? '隐藏 Token' : '显示 Token'} onClick={() => setShowToken(value => !value)}>{showToken ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
              {hasToken && <label className="ai-checkbox"><input type="checkbox" checked={clearToken} onChange={event => { setClearToken(event.target.checked); setVerified(false); setError(''); setStatus('') }} />清除已保存的 Token</label>}
              <p className="ai-field-note">Token 通过系统密钥存储加密保存在本机。</p>
              <label>模型名<input value={draft.model} placeholder="填写服务商提供的模型 ID" spellCheck={false} onChange={event => patch('model', event.target.value)} /></label>
              <p className="ai-field-note">发送图片需要选择支持视觉输入的模型。邦邦会按问题参考软件指南或查询相关状态。</p>
            </section>
            <p className="ai-field-note">达到 20 轮（含本次提问）或上下文文字超过 32768 字符时自动压缩较早对话，完整历史仍保存在本机。其他参数由软件使用默认值。</p>
          </fieldset>
        </div>
        <footer className="settings-detail-footer">
          {error && <p className="form-error" role="alert">{error}</p>}
          {status && <p className="ai-success" role="status">{status}</p>}
          <span>{verified ? '此配置已通过检验。' : '检验配置会发送一条简短消息，通过后自动保存并启用。'}</span>
          <div>{!loaded && !loading && <button className="outline-button" onClick={() => setLoadVersion(value => value + 1)}>重新读取</button>}<button className="outline-button" disabled={!loaded || !!working || !draft.baseUrl.trim() || !draft.model.trim()} onClick={() => void execute('test')}>{working === 'test' ? <LoaderCircle className="ai-spin" size={16} /> : <Unplug size={16} />}检验配置</button><button className="primary-button" disabled={!loaded || !!working} onClick={() => void execute('save')}>{working === 'save' ? <LoaderCircle className="ai-spin" size={16} /> : <Save size={16} />}保存 AI 设置</button></div>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
