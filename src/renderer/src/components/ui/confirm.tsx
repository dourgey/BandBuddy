import * as Dialog from '@radix-ui/react-dialog'
import { useId, useRef, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'

interface ActionOptions { title: string; message?: string; confirmLabel?: string; destructive?: boolean }
interface Request extends ActionOptions { id: number; defaultValue?: string; prompt: boolean; resolve(value: string | boolean | null): void }
let sequence = 0
let queue: Request[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const notify = (): void => listeners.forEach(listener => listener())
function request(options: ActionOptions & { prompt: boolean; defaultValue?: string }): Promise<string | boolean | null> {
  return new Promise(resolve => { queue = [...queue, { ...options, id: ++sequence, resolve }]; notify() })
}
export async function confirmAction(options: ActionOptions): Promise<boolean> { return await request({ ...options, prompt: false }) === true }
export async function promptAction(options: Omit<ActionOptions, 'destructive'> & { defaultValue?: string }): Promise<string | null> { return await request({ ...options, prompt: true }) as string | null }
function settle(value: string | boolean | null): void { const current = queue[0]; queue = queue.slice(1); current?.resolve(value); notify() }

export function ConfirmHost(): React.JSX.Element | null {
  const active = useSyncExternalStore(subscribe, () => queue[0] ?? null)
  return active ? <ActionDialog key={active.id} request={active} /> : null
}
function ActionDialog({ request }: { request: Request }): React.JSX.Element {
  const descriptionId = useId()
  const composing = useRef(false)
  const [value, setValue] = useState(request.defaultValue ?? '')
  const cancel = (): void => settle(request.prompt ? null : false)
  return <Dialog.Root open onOpenChange={open => { if (!open) cancel() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay bb-confirm-overlay" data-dialog-open="true" />
    <Dialog.Content className="dialog-content bb-confirm" data-dialog-open="true" aria-describedby={request.message ? descriptionId : undefined}>
      <Dialog.Title>{request.title}</Dialog.Title>
      {request.message && <Dialog.Description id={descriptionId}>{request.message}</Dialog.Description>}
      <form onSubmit={event => { event.preventDefault(); settle(request.prompt ? value : true) }}>
        {request.prompt && <input aria-label={request.title} value={value} maxLength={200} autoFocus onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }} onChange={event => setValue(event.target.value)} />}
        <div className="bb-dialog-actions"><button type="button" className="outline-button" onClick={cancel}>取消</button><button type="submit" className={`primary-button ${request.destructive ? 'danger-button' : ''}`} disabled={request.prompt && !value.trim()}>{request.confirmLabel ?? '确认'}</button></div>
      </form>
      <Dialog.Close className="dialog-close" aria-label="关闭"><X size={18} /></Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
