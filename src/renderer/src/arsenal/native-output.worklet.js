/* This tap receives the existing backing mix after stretch, gain and limiting. */
class ArsenalOutputTap extends AudioWorkletProcessor {
  constructor() {
    super(); this.enabled = false; this.epoch = 0; this.credits = 0;
    this.buffer = new Float32Array(2048); this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data.ack) {
        if (data.epoch === this.epoch) this.credits = Math.min(4, this.credits + 1);
      } else {
        this.enabled = Boolean(data.enabled); this.epoch = data.epoch;
        this.credits = this.enabled ? 4 : 0; this.offset = 0;
      }
    };
  }
  process(inputs) {
    if (!this.enabled) return true;
    const channels = inputs[0];
    for (let i = 0; i < 128; i++) {
      this.buffer[this.offset++] = channels?.[0]?.[i] ?? 0;
      this.buffer[this.offset++] = channels?.[1]?.[i] ?? channels?.[0]?.[i] ?? 0;
      if (this.offset === this.buffer.length) {
        // Never build an unbounded MessagePort queue while the UI is busy.
        // Without a credit, discard this interval and resume with current audio.
        if (this.credits > 0) {
          this.credits--;
          this.port.postMessage({ epoch: this.epoch, time: currentTime, samples: this.buffer }, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
        }
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('bandbuddy-arsenal-output',ArsenalOutputTap)
