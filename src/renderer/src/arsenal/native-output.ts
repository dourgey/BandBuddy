import { nativeOutputRoutes } from './output-coordinator.js'
import { defaultEffectChain, type ArsenalApi } from '@shared/arsenal.js'
const reportOutputError=(error:string):void=>{window.dispatchEvent(new CustomEvent('arsenal-output-error',{detail:error}))}
const routes=new WeakMap<object,{input:GainNode;active:boolean;sink:string}>(),slots=new Set<number>()
/** Keep the user's browser output choice while the native device owns playback. */
export function retainArsenalSink(context:object,deviceId:string):boolean{const route=routes.get(context);if(!route)return false;route.sink=deviceId;return route.active}
/** One stereo bus per AudioContext. No source, speed or pitch processing is replaced. */
export function arsenalDestination(context:AudioContext):AudioNode{
  if(typeof window==='undefined')return context.destination
  const bridgeWindow=window as unknown as {bandbuddy?:{arsenal?:ArsenalApi}}
  if(!context.audioWorklet||typeof AudioWorkletNode==='undefined'||!bridgeWindow.bandbuddy?.arsenal?.feed)return context.destination
  const existing=routes.get(context);if(existing)return existing.input
  const bus=Array.from({length:8},(_,i)=>i).find(i=>!slots.has(i));if(bus===undefined)return context.destination
  slots.add(bus)
  const input=context.createGain(),local=context.createGain();input.connect(local).connect(context.destination)
  const selector=context as AudioContext&{sinkId?:string|object;setSinkId?(value:string|{type:'none'}):Promise<void>}
  const route={input,active:false,sink:typeof selector.sinkId==='string'?selector.sinkId:''};routes.set(context,route)
  let prepared=false
  let node:AudioWorkletNode|undefined,desired=false,failed=false,closed=false,pending=0,transition=Promise.resolve(),ready=Promise.resolve()
  const apply=():void=>{transition=transition.catch(()=>undefined).then(async()=>{
    if(closed||!node)return
    const active=desired&&!failed;if(route.active===active&&!prepared)return
    if(active){prepared=false;if(selector.setSinkId)await selector.setSinkId({type:'none'});if(closed)return;local.gain.setValueAtTime(0,context.currentTime);route.active=true;node.port.postMessage({enabled:true})}
    else{prepared=false;node.port.postMessage({enabled:false});route.active=false;void bridgeWindow.bandbuddy!.arsenal!.feed({bus,sampleRate:context.sampleRate,samples:[],reset:true}).catch(()=>undefined);if(selector.setSinkId)await selector.setSinkId(route.sink);local.gain.setValueAtTime(1,context.currentTime)}
  }).catch(e=>{route.active=false;local.gain.value=1;reportOutputError(`伴奏输出切换失败：${String(e)}`)})}
  const managed={prepare:async()=>{await ready;await transition;if(!node)throw new Error('统一输出模块未就绪');prepared=true;local.gain.setValueAtTime(0,context.currentTime);if(selector.setSinkId)await selector.setSinkId({type:'none'})},restore:async()=>{prepared=false;route.active=false;node?.port.postMessage({enabled:false});if(selector.setSinkId)await selector.setSinkId(route.sink);local.gain.setValueAtTime(1,context.currentTime)}}
  nativeOutputRoutes.add(managed)
  const failOutput=(reason:string):void=>{if(failed)return;failed=true;reportOutputError(`${reason}；正在停止监听并恢复常规播放输出。`);void bridgeWindow.bandbuddy!.arsenal!.monitor({mode:'off',chain:defaultEffectChain()}).catch(e=>reportOutputError(String(e))).finally(apply)}
  const off=bridgeWindow.bandbuddy!.arsenal!.onMonitor(state=>{desired=state.active;if(!desired)failed=false;apply()})
  void bridgeWindow.bandbuddy!.arsenal!.monitorState().then(state=>{desired=state.active;apply()})
  ready=context.audioWorklet.addModule(new URL('./native-output.worklet.js',import.meta.url).href).then(()=>{
    if(closed)return
    node=new AudioWorkletNode(context,'bandbuddy-arsenal-output',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'})
    input.connect(node).connect(context.destination)
    node.port.onmessage=event=>{
      if(!route.active||closed)return
      if(pending>=4){failOutput('伴奏传输未及时完成');return}
      pending++;void bridgeWindow.bandbuddy!.arsenal!.feed({bus,sampleRate:context.sampleRate,samples:Array.from(event.data as Float32Array)}).then(ok=>{if(!ok&&desired)failOutput('原生输出已关闭')}).catch(e=>{failOutput(`伴奏传输中断：${String(e)}`)}).finally(()=>{pending--})
    };apply()
  }).catch(e=>{reportOutputError(`无法启动统一音频输出：${String(e)}`)})
  const dispose=():void=>{if(context.state!=='closed')return;closed=true;off();nativeOutputRoutes.delete(managed);slots.delete(bus);routes.delete(context);node?.disconnect();input.disconnect();local.disconnect();void bridgeWindow.bandbuddy!.arsenal!.feed({bus,sampleRate:context.sampleRate,samples:[],reset:true}).catch(()=>undefined);context.removeEventListener('statechange',dispose)}
  context.addEventListener('statechange',dispose)
  return input
}
