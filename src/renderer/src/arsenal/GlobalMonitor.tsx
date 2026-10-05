import { useEffect } from 'react'
import { useArsenal, setMonitor, startArsenal } from './workspace-store.js'
import '../pages/arsenal.css'
export function GlobalMonitor({visible,onOpen}:{visible:boolean;onOpen():void}):React.JSX.Element|null{
  useEffect(()=>{void startArsenal()},[])
  const monitor=useArsenal(s=>s.monitor),quick=useArsenal(s=>s.workspace.quick),error=useArsenal(s=>s.error)
  useEffect(()=>{if(!monitor.active)return;let alive=true;const timer=setInterval(()=>{void window.bandbuddy.arsenal.command({action:'workspace'}).then(workspace=>{if(alive)useArsenal.setState({workspace})}).catch(()=>undefined)},1000);return()=>{alive=false;clearInterval(timer)}},[monitor.active])
  if(!visible||(!monitor.active&&!error))return null
  if(error)return <div className="arsenal-global" role="alert"><button onClick={onOpen}>军火库：{error}</button><button aria-label="关闭军火库提示" onClick={()=>useArsenal.setState({error:''})}>×</button></div>
  return <div className="arsenal-global"><i/><button onClick={onOpen}>军火库 · {monitor.tunerActive?'调音静音':quick.recording?'正在快录':quick.looping?'DI 循环':monitor.mode==='wet'?'效果监听':'干声监听'}</button><button onClick={()=>void setMonitor('off')}>停止{quick.recording?'并保存':''}</button></div>
}
