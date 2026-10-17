import { lazy, Suspense, useState } from 'react'
import { Sparkles } from 'lucide-react'
import './ai.css'

const AiChat = lazy(() => import('./AiChat.js'))

export function AiLauncher(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [visited, setVisited] = useState(false)
  return <>
    <button className="ai-launcher" hidden={open} aria-label="打开 AI 对话" title="AI 图文对话" onClick={() => { setVisited(true); setOpen(true) }}><Sparkles size={23} /><span>AI</span></button>
    {visited && <Suspense fallback={<button className="ai-launcher" onClick={() => setOpen(false)} aria-label="取消打开 AI 对话">载入中</button>}><AiChat open={open} onOpenChange={setOpen} /></Suspense>}
  </>
}
