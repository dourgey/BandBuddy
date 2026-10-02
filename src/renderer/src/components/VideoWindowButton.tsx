import { useEffect, useRef, useState } from 'react'
import { MonitorPlay } from 'lucide-react'
import type { VideoPlaybackState } from '../video-sync.js'

export function VideoWindowButton({ src, title, songId, ...state }: VideoPlaybackState & {
  src: string; title: string; songId: string
}): React.JSX.Element {
  const child = useRef<Window | null>(null)
  const [error, setError] = useState(false)
  const latest = useRef({ src, title, ...state })
  latest.current = { src, title, ...state }
  useEffect(() => {
    const send = (): void => { if (child.current && !child.current.closed) child.current.postMessage({ type: 'bandbuddy-video', ...latest.current }, '*') }
    const ready = (event: MessageEvent): void => { if (event.source === child.current && event.data?.type === 'bandbuddy-video-ready') send() }
    window.addEventListener('message', ready)
    const timer = window.setInterval(send, 80)
    return () => { window.clearInterval(timer); window.removeEventListener('message', ready); child.current?.close(); child.current = null }
  }, [songId])
  return <button className="queue-button" aria-label="打开视频窗口" title={error ? '视频窗口未能打开，请重试' : '在独立窗口播放视频画面'} onClick={() => {
    if (child.current && !child.current.closed) { child.current.focus(); return }
    child.current = window.open(new URL('video.html', window.location.href).href, 'bandbuddy-video', 'width=960,height=600')
    setError(!child.current)
  }}><MonitorPlay size={21} /></button>
}
