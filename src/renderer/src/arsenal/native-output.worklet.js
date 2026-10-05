/* This tap receives the existing backing mix after stretch, gain and limiting. */
class ArsenalOutputTap extends AudioWorkletProcessor {
  constructor(){super();this.enabled=false;this.buffer=new Float32Array(2048);this.offset=0;this.port.onmessage=e=>{this.enabled=Boolean(e.data.enabled);this.offset=0}}
  process(inputs){if(!this.enabled)return true;const channels=inputs[0];for(let i=0;i<128;i++){this.buffer[this.offset++]=channels?.[0]?.[i]??0;this.buffer[this.offset++]=channels?.[1]?.[i]??channels?.[0]?.[i]??0;if(this.offset===this.buffer.length){this.port.postMessage(this.buffer,[this.buffer.buffer]);this.buffer=new Float32Array(2048);this.offset=0}}return true}
}
registerProcessor('bandbuddy-arsenal-output',ArsenalOutputTap)
