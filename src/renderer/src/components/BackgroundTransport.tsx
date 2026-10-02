import { useRecordingSession } from '../recording-session.js'
import { ArrowRight, Pause, AudioLines } from 'lucide-react'
import { pauseAudioSession, useAudioSession, type AudioSessionOwner } from '../audio-session.js'

export function BackgroundTransport({ view, onReturn }: { view: string; onReturn(owner: AudioSessionOwner): void }): React.JSX.Element | null {
  const session = useAudioSession()
  const recording = useRecordingSession()
  if (recording || !session || session.owner === view || (session.owner === 'practice' && view === 'library')) return null
  const origin = session.owner === 'practice' ? '练习室' : session.owner === 'rehearsal' ? '排练房' : '练功房'
  return <aside className="background-transport" aria-label="后台播放控制">
    <AudioLines size={17} aria-hidden="true" /><span><small>{origin}正在播放</small><b>{session.label}</b></span>
    <button className="outline-button compact" aria-label={`暂停${origin}播放`} onClick={pauseAudioSession}><Pause size={15} />暂停</button>
    <button className="outline-button compact" onClick={() => onReturn(session.owner)}>返回{origin}<ArrowRight size={15} /></button>
  </aside>
}
