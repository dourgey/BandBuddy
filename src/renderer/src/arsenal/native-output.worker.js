// The AudioWorklet port belongs to this worker. Rendering, waveforms and React
// can block the window without blocking PCM delivery or its acknowledgments.
let port, url, sampleRate, epoch = 0, active = false;
let transfers = Promise.resolve();
const send = async (samples, reset = false) => {
  const target = new URL(url);
  target.searchParams.set('rate', String(sampleRate));
  if (reset) target.searchParams.set('reset', '1');
  const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: samples.buffer, signal: AbortSignal.timeout(5000) });
  if (!response.ok && !(reset && response.status === 409)) throw new Error(`PCM_OUTPUT_${response.status}`);
};
self.onmessage = ({ data }) => {
  if (data.port) {
    port = data.port; url = data.url; sampleRate = data.sampleRate;
    port.onmessage = ({ data: packet }) => {
      const version = packet.epoch;
      if (!active || version !== epoch) return;
      transfers = transfers.catch(() => {}).then(async () => {
        if (!active || version !== epoch) return;
        try { await send(packet.samples); }
        catch (error) {
          if (active && version === epoch) { active = false; self.postMessage({ error: String(error), epoch: version }); }
        }
      }).finally(() => { if (version === epoch) port.postMessage({ ack: true, epoch: version }); });
    };
    self.postMessage({ ready: true });
  } else if (data.control) {
    epoch = data.control.epoch; active = Boolean(data.control.enabled);
    port.postMessage(data.control);
  } else if (data.reset) {
    transfers = transfers.catch(() => {}).then(() => send(new Float32Array(), true))
      .then(() => self.postMessage({ id: data.id }), error => self.postMessage({ id: data.id, error: String(error) }));
  }
};
