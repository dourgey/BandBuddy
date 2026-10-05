import { useEffect, useState } from 'react'
import type { ArsenalMonitorState } from '@shared/arsenal.js'
export function InlineTuner({active,onToast}:{active:boolean;onToast(message:string):void}):React.JSX.Element{
  const [state,setState]=useState<ArsenalMonitorState|null>(null),[reference,setReference]=useState(440)
  useEffect(()=>{const off=window.bandbuddy.arsenal.onMonitor(setState);void window.bandbuddy.arsenal.monitorState().then(setState);return off},[])
  const hz=state?.tunerHz??0,n=hz>0?69+12*Math.log2(hz/reference):0,note=Math.round(n),cents=Math.round((n-note)*100),names=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B']
  const enabled=state?.tunerActive&&active
  return <div className="inline-tuner"><button disabled={!active} aria-pressed={Boolean(enabled)} onClick={()=>{void window.bandbuddy.arsenal.command({action:'tuner',enabled:!enabled}).catch(e=>onToast(String(e)))}}>调音{enabled?' · 静音':''}</button>{enabled&&<><span className={`tuner-reading ${Math.abs(cents)<5?'in-tune':''}`} aria-live="polite">{hz>0?`${names[(note%12+12)%12]}${Math.floor(note/12)-1} · ${cents>0?'+':''}${cents} cent`:'— 等待输入'}</span><label>A4 <input aria-label="调音标准频率" type="number" min={430} max={450} value={reference} onChange={e=>setReference(Math.max(430,Math.min(450,Number(e.target.value))))}/> Hz</label></>}</div>
}
