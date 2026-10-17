import { memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
const components: Components = {
  table: ({ children }) => <div className="ai-markdown-table" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>,
  // Keep model-supplied destinations readable without navigating the desktop app
  // or automatically fetching remote images. Uploaded images have their own preview.
  a: ({ children, href }) => <span className="ai-markdown-link">{children}{href && href !== String(children) ? ` (${href})` : ''}</span>,
  img: ({ alt }) => <span className="ai-markdown-image">[图片：{alt || '未命名图片'}]</span>
}

export const AiMessageText = memo(function AiMessageText({ text, markdown = true }: { text: string; markdown?: boolean }): React.JSX.Element {
  return markdown
    ? <div className="ai-message-text ai-markdown"><Markdown remarkPlugins={plugins} components={components} skipHtml>{text}</Markdown></div>
    : <div className="ai-message-text">{text}</div>
})
