import * as Dialog from '@radix-ui/react-dialog'
import { Copy, History, ImagePlus, LoaderCircle, MessageSquare, Minus, Pencil, Plus, RotateCcw, Send, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AI_MAX_IMAGES, AI_MAX_IMAGE_BYTES, AI_MAX_TEXT, AI_MAX_TOTAL_IMAGE_BYTES, type AiConversation, type AiConversationSummary, type AiImage, type AiMessage, type AiSettingsView } from '@shared/ai.js'
import { confirmAction, promptAction } from '../components/ui/confirm.js'
import { aiUiError as toUserErrorMessage } from './errors.js'
import { LaboratoryDialog } from './LaboratoryDialog.js'
import { AiMessageText } from './AiMessageText.js'

interface Draft { text: string; images: AiImage[] }
const EMPTY_DRAFT: Draft = { text: '', images: [] }
function savedSelection(): string | null { try { return localStorage.getItem('bandbuddy.ai.selected') } catch { return null } }

export function mergeAiMessages(snapshot: AiConversation, previous: AiConversation | undefined, updates: Map<string, AiMessage>): AiConversation {
  if (previous && previous.revision > snapshot.revision) snapshot = previous
  return { ...snapshot, messages: snapshot.messages.map(message => {
    const candidates = [previous?.messages.find(item => item.id === message.id), updates.get(message.id)]
    return candidates.reduce<AiMessage>((latest, item) => item && item.revision > latest.revision ? item : latest, message)
  }) }
}

async function readImage(file: File): Promise<AiImage> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片。')
  if (file.size > AI_MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MB。')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'))
    reader.readAsDataURL(file)
  })
  await new Promise<void>((resolve, reject) => {
    const preview = new Image()
    preview.onload = () => resolve()
    preview.onerror = () => reject(new Error('无法打开这张图片，请检查文件是否损坏。'))
    preview.src = dataUrl
  })
  return { id: crypto.randomUUID(), name: (file.name || '粘贴的图片').slice(0, 255), dataUrl }
}

export default function AiChat({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }): React.JSX.Element {
  const api = window.bandbuddy.ai
  const [list, setList] = useState<AiConversationSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, AiConversation>>({})
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [settings, setSettings] = useState<AiSettingsView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [initialLoading, setInitialLoading] = useState(true)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [readingImages, setReadingImages] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [preview, setPreview] = useState<AiImage | null>(null)
  const [refresh, setRefresh] = useState(0)
  const listVersion = useRef(0)
  const updates = useRef(new Map<string, AiMessage>())
  const sending = useRef(false), imageReading = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accept = useCallback((conversation: AiConversation): void => {
    setDetails(previous => ({ ...previous, [conversation.id]: mergeAiMessages(conversation, previous[conversation.id], updates.current) }))
  }, [])
  const refreshList = useCallback(async (): Promise<void> => {
    if (!api) return
    const version = ++listVersion.current
    const result = await api.list()
    if (!mounted.current || version !== listVersion.current) return
    setList(result)
    setSelected(current => current && result.some(item => item.id === current) ? current : result.find(item => item.id === savedSelection())?.id ?? result[0]?.id ?? null)
  }, [api])
  useEffect(() => {
    if (!api || !open) { if (!api) { setInitialLoading(false); setError('AI 服务不可用，请使用新版桌面应用。') }; return }
    let live = true
    void Promise.all([refreshList(), api.getSettings().then(value => { if (live) setSettings(value) })]).catch(reason => { if (live) setError(toUserErrorMessage(reason, '读取 AI 数据失败')) }).finally(() => { if (live) setInitialLoading(false) })
    return () => { live = false }
  }, [api, open, refreshList, refresh])
  useEffect(() => {
    if (!api) return
    return api.onChanged(event => {
      if (event.type === 'message') {
        const message = event.message
        const previous = updates.current.get(message.id)
        if (previous && previous.revision >= message.revision) return
        updates.current.set(message.id, message)
        setDetails(all => {
          const conversation = all[message.conversationId]
          if (!conversation || !conversation.messages.some(item => item.id === message.id)) return all
          return { ...all, [conversation.id]: { ...conversation, messages: conversation.messages.map(item => item.id === message.id && item.revision < message.revision ? message : item) } }
        })
      } else if (event.type === 'conversations') void refreshList().catch(reason => setError(toUserErrorMessage(reason, '刷新历史失败')))
      else void api.getSettings().then(setSettings).catch(reason => setError(toUserErrorMessage(reason, '刷新 AI 设置失败')))
    })
  }, [api, refreshList])
  useEffect(() => {
    if (!api || !selected || !open) return
    let live = true
    follow.current = true; setLoading(true)
    try { localStorage.setItem('bandbuddy.ai.selected', selected) } catch { /* History remains in SQLite if local preferences are unavailable. */ }
    void api.get(selected).then(value => { if (live && value) accept(value) }, reason => { if (live) setError(toUserErrorMessage(reason, '读取对话失败')) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [api, selected, open, accept, refresh])
  const conversation = selected ? details[selected] : undefined
  const key = selected ?? 'new', draft = drafts[key] ?? EMPTY_DRAFT
  const messages = conversation?.messages ?? []
  const last = messages.at(-1), busy = last?.status === 'streaming'
  const ready = !!settings
  useEffect(() => {
    if (open && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [open, selected, last?.text, last?.status, messages.length])
  const patchDraft = (patch: Partial<Draft>): void => setDrafts(current => ({ ...current, [key]: { ...(current[key] ?? EMPTY_DRAFT), ...patch } }))
  const addImages = async (files: File[]): Promise<void> => {
    if (!files.length || imageReading.current || pending) return
    imageReading.current = true; setReadingImages(true); setError('')
    const target = key
    try {
      if (draft.images.length + files.length > AI_MAX_IMAGES) throw new Error('每条消息最多添加 4 张图片。')
      const estimated = draft.images.reduce((size, item) => size + Math.floor((item.dataUrl.length - item.dataUrl.indexOf(',') - 1) * 3 / 4), 0)
      if (estimated + files.reduce((size, file) => size + file.size, 0) > AI_MAX_TOTAL_IMAGE_BYTES) throw new Error('每条消息的图片合计不能超过 12 MB。')
      const images = await Promise.all(files.map(readImage))
      setDrafts(current => ({ ...current, [target]: { ...(current[target] ?? EMPTY_DRAFT), images: [...(current[target]?.images ?? []), ...images] } }))
    } catch (reason) { setError(toUserErrorMessage(reason, '添加图片失败')) }
    finally { imageReading.current = false; setReadingImages(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const send = async (retry = false): Promise<void> => {
    if (!api || !ready || sending.current || busy || imageReading.current || loading || (!retry && !draft.text.trim() && !draft.images.length)) return
    sending.current = true; setPending(true); setError(''); follow.current = true
    try {
      let id = selected
      let draftKey = key
      if (!id) {
        const created = await api.create(); id = created.id; draftKey = id
        setDrafts(current => ({ ...current, [created.id]: draft, new: EMPTY_DRAFT }))
        accept(created); setSelected(id)
      }
      const result = retry ? await api.retry(id) : await api.send({ conversationId: id, text: draft.text, images: draft.images })
      accept(result)
      if (!retry) setDrafts(current => ({ ...current, [draftKey]: EMPTY_DRAFT }))
      void refreshList().catch(() => undefined)
    } catch (reason) { setError(toUserErrorMessage(reason, '发送失败，输入内容已保留')) }
    finally { sending.current = false; setPending(false); input.current?.focus() }
  }
  const newChat = async (): Promise<void> => {
    if (!api || pending) return
    if (conversation && !conversation.messages.length) { input.current?.focus(); return }
    setPending(true); setError('')
    try { const created = await api.create(); accept(created); setSelected(created.id); await refreshList() }
    catch (reason) { setError(toUserErrorMessage(reason, '新建对话失败')) }
    finally { setPending(false); input.current?.focus() }
  }
  const rename = async (): Promise<void> => {
    if (!api || !conversation) return
    const title = await promptAction({ title: '重命名对话', defaultValue: conversation.title, confirmLabel: '保存' })
    if (!title?.trim()) return
    if (title.trim().length > 100) { setError('对话名称最多 100 个字符。'); return }
    try { await api.rename(conversation.id, title.trim()); accept({ ...conversation, title: title.trim() }); await refreshList() }
    catch (reason) { setError(toUserErrorMessage(reason, '重命名失败')) }
  }
  const remove = async (): Promise<void> => {
    if (!api || !conversation || busy) return
    const deleting = conversation.id
    if (!await confirmAction({ title: '删除对话', message: `“${conversation.title}”的全部消息和图片将从本机删除。`, confirmLabel: '删除', destructive: true })) return
    try {
      await api.delete(deleting)
      setDetails(current => { const next = { ...current }; delete next[deleting]; return next })
      setDrafts(current => { const next = { ...current }; delete next[deleting]; return next })
      for (const [id, message] of updates.current) if (message.conversationId === deleting) updates.current.delete(id)
      await refreshList()
    } catch (reason) { setError(toUserErrorMessage(reason, '删除失败')) }
  }
  const copy = async (message: AiMessage): Promise<void> => {
    try { await navigator.clipboard.writeText(message.text); setCopied(message.id) } catch { setError('无法复制，请选中文字后手动复制。') }
  }
  return <>
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}><Dialog.Portal>
      <Dialog.Content id="ai-chat-window" className="ai-chat-window" data-dialog-open="true" onKeyDown={event => event.stopPropagation()} onInteractOutside={event => event.preventDefault()} onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }} onCloseAutoFocus={event => event.preventDefault()}>
        <header className="ai-chat-header"><span className="ai-header-mark"><Sparkles size={21} /></span><div><Dialog.Title>AI 对话</Dialog.Title><Dialog.Description>邦邦 · 陪你聊音乐，也帮你用好软件</Dialog.Description></div><nav aria-label="AI 对话操作">
          <button className="ai-icon-button" aria-label="切换历史对话" title="历史对话" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><History size={18} /></button>
          <button className="ai-icon-button" aria-label="新建对话" title="新建对话" disabled={initialLoading || pending || !api} onClick={() => void newChat()}><Plus size={20} /></button>
          <button className="ai-icon-button" aria-label="AI 设置" title="实验室功能" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
          <Dialog.Close className="ai-icon-button" aria-label="收起 AI 对话" title="收起对话"><Minus size={20} /></Dialog.Close>
        </nav></header>
        <div className={`ai-chat-body ${historyOpen ? 'with-history' : ''}`}>
          {historyOpen && <aside className="ai-history" aria-label="历史对话"><div className="ai-history-heading"><b>历史对话</b><span>{list.length}</span></div><div className="ai-history-list">
            {list.map(item => <button key={item.id} className={`ai-history-item ${selected === item.id ? 'selected' : ''}`} aria-pressed={selected === item.id} disabled={pending} onClick={() => { setError(''); setSelected(item.id) }}><span><MessageSquare size={14} /><b>{item.title}</b></span><small>{item.preview || '还没有消息'}</small><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</time></button>)}
            {!list.length && !initialLoading && <p className="ai-history-empty">对话会自动保存在这里。</p>}
          </div><p className="ai-history-note">消息与图片保存在本机</p></aside>}
          <section className="ai-conversation" aria-label="当前对话">
            <div className="ai-conversation-heading"><b title={conversation?.title}>{conversation?.title || '新对话'}</b>{conversation && <><button className="ai-icon-button" title="重命名对话" aria-label="重命名对话" onClick={() => void rename()}><Pencil size={14} /></button><button className="ai-icon-button" title="删除对话" aria-label="删除对话" disabled={busy || pending} onClick={() => void remove()}><Trash2 size={14} /></button></>}</div>
            <div className="ai-messages" ref={scroll} onScroll={() => { if (scroll.current) follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 90 }}>
              {(initialLoading || loading) && <p className="ai-loading" role="status"><LoaderCircle className="ai-spin" size={17} />正在读取对话…</p>}
              {!messages.length && !initialLoading && !loading && <div className="ai-empty"><span><Sparkles size={31} /></span><h3>有什么想聊的？</h3><p>输入文字，或添加图片一起提问。<br />每段对话都可以随时回来继续。</p>{!ready && <button className="outline-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} />配置 AI 接口</button>}</div>}
              {messages.map(message => <article key={message.id} className={`ai-message ${message.role}`} aria-label={message.role === 'user' ? '我的消息' : 'AI 回复'}>
                <div className="ai-message-meta"><b>{message.role === 'user' ? '你' : '邦邦'}</b><span>{message.role === 'user' ? new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
                {!!message.images.length && <div className="ai-message-images">{message.images.map(item => <button key={item.id} onClick={() => setPreview(item)} title={item.name}><img src={item.dataUrl} alt={item.name} /></button>)}</div>}
                {message.text && <AiMessageText text={message.text} markdown={message.role === 'assistant'} />}
                {message.status === 'streaming' && <p className="ai-generating" role="status"><LoaderCircle className="ai-spin" size={13} />{message.text ? '正在回复…' : '正在等待模型回复…'}</p>}
                {message.error && <p className={`ai-message-error ${message.status}`} role={message.status === 'error' ? 'alert' : 'status'}>{message.error}</p>}
                {message.finishReason === 'length' && <p className="ai-message-error">已达到输出上限，可继续提问让邦邦接着回答。</p>}
                <div className="ai-message-actions">{message.text && message.status !== 'streaming' && <button onClick={() => void copy(message)} aria-label="复制消息"><Copy size={13} />{copied === message.id ? '已复制' : '复制'}</button>}{message.id === last?.id && ['error', 'cancelled'].includes(message.status) && <button disabled={pending || !ready} onClick={() => void send(true)}><RotateCcw size={13} />重试回复</button>}</div>
              </article>)}
            </div>
            <div className="ai-composer" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation() } }} onDrop={event => { event.preventDefault(); event.stopPropagation(); void addImages(Array.from(event.dataTransfer.files)) }}>
              {error && <div className="ai-composer-error" role="alert"><span>{error}</span><button className="ai-icon-button" aria-label="重新读取 AI 数据" onClick={() => { setError(''); setRefresh(value => value + 1) }}><RotateCcw size={14} /></button><button className="ai-icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={14} /></button></div>}
              {!!draft.images.length && <div className="ai-attachments">{draft.images.map(item => <div key={item.id}><button className="ai-attachment-preview" onClick={() => setPreview(item)} title={item.name}><img src={item.dataUrl} alt={item.name} /></button><button className="ai-remove-image" aria-label={`移除图片 ${item.name}`} onClick={() => patchDraft({ images: draft.images.filter(image => image.id !== item.id) })}><X size={12} /></button></div>)}</div>}
              <textarea ref={input} aria-label="消息内容" placeholder="输入消息，也可以粘贴或拖入图片…" value={draft.text} maxLength={AI_MAX_TEXT} disabled={pending || initialLoading} onChange={event => patchDraft({ text: event.target.value })} onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void addImages(images) } }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
              <div className="ai-composer-toolbar"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择图片" onChange={event => void addImages(Array.from(event.target.files ?? []))} /><button className="ai-icon-button" aria-label="添加图片" title="添加图片（最多 4 张，单张 5 MB）" disabled={readingImages || pending || draft.images.length >= AI_MAX_IMAGES} onClick={() => fileInput.current?.click()}>{readingImages ? <LoaderCircle className="ai-spin" size={18} /> : <ImagePlus size={18} />}</button><span>Enter 发送 · Shift + Enter 换行</span>{busy ? <button className="ai-send-button stop" disabled={pending} onClick={() => { if (api && selected) void api.cancel(selected).catch(reason => setError(toUserErrorMessage(reason, '停止失败'))) }}><Square size={13} />停止生成</button> : <button className="ai-send-button" aria-label="发送消息" disabled={!ready || pending || readingImages || loading || initialLoading || (!draft.text.trim() && !draft.images.length)} onClick={() => void send()}>{pending ? <LoaderCircle className="ai-spin" size={16} /> : <Send size={16} />}发送</button>}</div>
              {!ready && messages.length > 0 && <button className="ai-configure-link" onClick={() => setSettingsOpen(true)}>先配置 AI 接口，再继续对话</button>}
            </div>
          </section>
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    <LaboratoryDialog open={settingsOpen && open} onOpenChange={setSettingsOpen} />
    <Dialog.Root open={!!preview && open} onOpenChange={next => { if (!next) setPreview(null) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay settings-detail-overlay" data-dialog-open="true" /><Dialog.Content className="dialog-content ai-image-dialog" data-dialog-open="true" onKeyDown={event => event.stopPropagation()} aria-describedby={undefined}><Dialog.Title>{preview?.name}</Dialog.Title><Dialog.Close className="dialog-close" aria-label="关闭图片预览"><X /></Dialog.Close>{preview && <img src={preview.dataUrl} alt={preview.name} />}</Dialog.Content></Dialog.Portal></Dialog.Root>
  </>
}
