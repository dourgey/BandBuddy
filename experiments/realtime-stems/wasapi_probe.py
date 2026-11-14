"""Play a known fixture on one WASAPI endpoint, demix its loopback, and measure the second endpoint."""
import argparse
from collections import Counter
from contextlib import ExitStack
import json
import queue
import time

import numpy as np
import pyaudiowpatch as pa
import soxr
from scipy.signal import correlate

from probe import DATA, RATE, Stream, fixture, model_for


SR = 48000
BLOCK = 480


def measure(recordings, reference, monitor_pcm):
    # Fit each window separately. Compare callback arrival times on the same
    # monotonic clock; this is an endpoint-loopback estimate, not acoustic latency.
    matches = {}
    for key, blocks in {**recordings, "render_match": recordings["processed"]}.items():
        signal = np.frombuffer(b"".join(b for _, b in blocks), np.float32).reshape(-1, 2).mean(1)
        ends = np.cumsum([len(b) // 8 for _, b in blocks])
        times = []
        strengths = []
        ref = monitor_pcm if key == "render_match" else reference
        for start in (2, 5, 8, 11, 14, 17):
            probe = ref[start*SR:(start+1)*SR].mean(1)
            lo, hi = max(0, (start-1)*SR), min(len(signal), (start+4)*SR)
            segment = signal[lo:hi]
            dots = correlate(segment, probe, mode="valid", method="fft")
            energies = np.r_[0., np.cumsum(segment.astype(float)**2)]
            denom = np.sqrt((energies[len(probe):] - energies[:-len(probe)]) * np.dot(probe, probe))
            scores = dots / np.maximum(denom, 1e-10)
            offset = int(np.argmax(scores))
            frame = lo + offset
            idx = int(np.searchsorted(ends, frame, side="right"))
            times.append(blocks[idx][0] - (ends[idx] - frame) / SR)
            strengths.append(round(float(scores[offset]), 3))
        matches[key] = (np.array(times), strengths)
    delays = np.round(1000 * (matches["processed"][0] - matches["source"][0]), 1)
    return {"lag_ms": delays.tolist(), "input_correlations": matches["source"][1],
            "output_correlations": matches["processed"][1], "render_correlations": matches["render_match"][1]}


def run(audio, source, sink, profile, listen_seconds, stem):
    worker = None
    if profile != "bypass":
        model = model_for("cuda")
        model.use_train_segment = False
        warm = Stream(model, profile, stem)
        warm.step(np.zeros((warm.hop, 2), np.float32))
        worker = Stream(model, profile, stem)
    test = b""
    if listen_seconds is None:
        mix, _, _ = fixture()
        reference = soxr.resample(np.concatenate([mix * g for g in (0.8, 1., 0.9, 0.7)]), RATE, SR)
        test = np.pad(reference, ((SR, 2*SR), (0, 0))).astype("f").tobytes()
    monitor_gain = 0.12 if listen_seconds is None else 1.0
    cursor = 0
    queued_input = queue.Queue(maxsize=150)
    queued_output = queue.Queue(maxsize=16)
    stats = Counter()
    snapshots = {"source": [], "processed": []}
    render_log = []
    pending = bytearray()
    playing = False

    def send_fixture(_, frames, timing, flags):
        nonlocal cursor
        count = frames * 8
        data = test[cursor:cursor+count]
        cursor += count
        if flags:
            stats["source_render_status"] += 1
        return data.ljust(count, b"\0"), pa.paContinue

    def capture(key):
        def callback(data, frames, timing, flags):
            if listen_seconds is None:
                snapshots[key].append((time.perf_counter(), data))
            if flags:
                stats[key + "_capture_status"] += 1
            if key == "source":
                try:
                    queued_input.put_nowait(data)
                except queue.Full:
                    stats["input_drops"] += 1
            return None, pa.paContinue
        return callback

    def monitor(_, frames, timing, flags):
        nonlocal playing
        count = frames * 8
        while len(pending) < count:
            try:
                packet = queued_output.get_nowait()
                if not playing:
                    # Let callbacks absorb variation in successive inference times.
                    pending.extend(bytes(round(0.04 * SR) * 8))
                pending.extend(packet)
                playing = True
            except queue.Empty:
                break
        data = bytes(pending[:count])
        del pending[:count]
        if playing and len(data) < count:
            stats["monitor_starved_frames"] += (count - len(data)) // 8
        if flags:
            stats["monitor_render_status"] += 1
        packet = data.ljust(count, b"\0")
        if listen_seconds is None:
            render_log.append(packet)
        return packet, pa.paContinue

    down = soxr.ResampleStream(SR, RATE, 2, quality="LQ")
    up = soxr.ResampleStream(RATE, SR, 2, quality="LQ")
    pcm = np.empty((0, 2), dtype="f")
    primed = False
    costs = []
    with ExitStack() as stack:
        def open_stream(callback, **kwargs):
            s = audio.open(rate=SR, channels=2, format=pa.paFloat32, frames_per_buffer=BLOCK,
                           stream_callback=callback, start=False, **kwargs)
            stack.callback(s.close)
            return s

        streams = []
        captures = [("source", source)]
        if listen_seconds is None:
            captures.append(("processed", sink))
        for key, dev in captures:
            loop = audio.get_wasapi_loopback_analogue_by_index(dev)["index"]
            streams.append(open_stream(capture(key), input=True, input_device_index=loop))
        streams.append(open_stream(monitor, output=True, output_device_index=sink))
        pa_latencies = {"source_capture": streams[0].get_input_latency(),
                        "monitor_render": streams[-1].get_output_latency()}
        if listen_seconds is None:
            pa_latencies["monitor_capture"] = streams[1].get_input_latency()
            streams.append(open_stream(send_fixture, output=True, output_device_index=source))
        for s in streams:
            s.start_stream()
        timeout = time.monotonic() + (listen_seconds or 28)
        while time.monotonic() < timeout:
            if listen_seconds is None and cursor >= len(test):
                break
            try:
                packet = queued_input.get(timeout=0.4)
            except queue.Empty:
                continue
            if worker is None:
                t = time.perf_counter()
                queued_output.put((np.frombuffer(packet, np.float32) * monitor_gain).tobytes(), timeout=0.5)
                costs.append(1000 * (time.perf_counter() - t))
                continue
            pcm = np.concatenate((pcm, down.resample_chunk(np.frombuffer(packet, np.float32).reshape(-1, 2))))
            if not primed and len(pcm) >= worker.future:
                worker.window[-worker.future:] = pcm[:worker.future]
                pcm = pcm[worker.future:]
                primed = True
            if primed and len(pcm) >= worker.hop:
                t = time.perf_counter()
                separated = up.resample_chunk(worker.step(pcm[:worker.hop]))
                costs.append(1000 * (time.perf_counter() - t))
                try:
                    queued_output.put_nowait((separated * monitor_gain).astype("f").tobytes())
                except queue.Full:
                    stats["output_drops"] += 1
                pcm = pcm[worker.hop:]
        for s in reversed(streams):
            s.stop_stream()

    if listen_seconds is not None:
        print(f"Processed {len(costs)} blocks in {listen_seconds}s. Callback counters: {dict(stats)}")
        return
    if cursor < len(test) or not costs:
        raise RuntimeError("WASAPI fixture stalled")
    result = {"profile": profile, "stem": stem, "fixture_seconds": len(reference) / SR, "blocks": len(costs),
              "source_device": audio.get_device_info_by_index(source)["name"],
              "monitor_device": audio.get_device_info_by_index(sink)["name"],
              "step_p95_ms": round(float(np.percentile(costs, 95)), 1),
              "portaudio_latency_s": pa_latencies, "callback_counters": dict(stats),
              **measure(snapshots, reference, np.frombuffer(b"".join(render_log), np.float32).reshape(-1, 2))}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    (DATA / f"wasapi-{profile}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=int, help="Virtual WASAPI playback device for the test source")
    parser.add_argument("--monitor", type=int, help="Separate WASAPI playback device for the result")
    parser.add_argument("--profile", choices=("bypass", "fast", "balanced", "quality"), default="balanced")
    parser.add_argument("--listen-seconds", type=int, help="Process an external app in real time without saving audio")
    parser.add_argument("--stem", choices=("drums", "bass", "other", "vocals", "guitar", "piano"), default="drums")
    args = parser.parse_args()
    if args.listen_seconds is not None and args.listen_seconds <= 0:
        parser.error("--listen-seconds must be positive")
    with pa.PyAudio() as audio:
        api = audio.get_host_api_info_by_type(pa.paWASAPI)["index"]
        outputs = {d["index"]: d["name"] for d in audio.get_device_info_generator()
                   if d["hostApi"] == api and d["maxOutputChannels"] >= 2}
        if args.source is None and args.monitor is None:
            print(outputs)
        elif args.source == args.monitor or not {args.source, args.monitor} <= outputs.keys():
            parser.error(f"Choose two different stereo WASAPI render endpoints: {outputs}")
        else:
            run(audio, args.source, args.monitor, args.profile, args.listen_seconds, args.stem)
