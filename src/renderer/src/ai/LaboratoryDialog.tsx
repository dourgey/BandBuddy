import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, FlaskConical, X } from 'lucide-react'
import { useState } from 'react'
import { AiSettingsDialog } from './AiSettingsDialog.js'

export function LaboratoryDialog({ open, onOpenChange, trigger = false }: { open: boolean; onOpenChange(open: boolean): void; trigger?: boolean }): React.JSX.Element {
  const [aiOpen, setAiOpen] = useState(false)
  return <Dialog.Root open={open} onOpenChange={next => { if (!aiOpen) onOpenChange(next) }}>
    {trigger && <Dialog.Trigger className="settings-category" aria-label="实验室功能"><span className="settings-category-icon"><FlaskConical /></span><span className="settings-category-copy"><b>实验室功能</b><small>探索正在完善的新功能</small><em>AI 对话</em></span><ChevronRight size={18} /></Dialog.Trigger>}
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay settings-detail-overlay" data-dialog-open="true" />
      <Dialog.Content className="dialog-content settings-detail" data-dialog-open="true" onKeyDown={event => event.stopPropagation()} onInteractOutside={event => event.preventDefault()}>
        <header className="settings-detail-header"><Dialog.Title>实验室功能</Dialog.Title><Dialog.Description>在这里配置和体验实验室中的新功能。</Dialog.Description></header>
        <Dialog.Close className="dialog-close" aria-label="关闭实验室功能"><X /></Dialog.Close>
        <div className="settings-detail-scroll"><div className="settings-categories"><AiSettingsDialog trigger open={open && aiOpen} onOpenChange={setAiOpen} /></div></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
