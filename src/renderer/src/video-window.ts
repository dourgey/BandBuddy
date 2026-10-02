import { VideoSynchronizer, type VideoPlaybackState } from './video-sync.js'
import './video-window.css'
const video = document.querySelector('video')!
const error = document.querySelector<HTMLElement>('#error')!
const sync = new VideoSynchronizer(video, () => { error.hidden = false })
let src = ''
window.addEventListener('message', (event: MessageEvent<VideoPlaybackState & { type: string; src: string; title: string }>) => {
  if (event.source !== window.opener || event.data?.type !== 'bandbuddy-video') return
  if (src !== event.data.src) { src = event.data.src; video.src = src; error.hidden = true }
  document.title = `${event.data.title} · BandBuddy 视频`
  sync.update(event.data)
})
document.querySelector('#fullscreen')!.addEventListener('click', () => {
  void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})
})
window.addEventListener('beforeunload', () => sync.dispose())
window.opener?.postMessage({ type: 'bandbuddy-video-ready' }, '*')
