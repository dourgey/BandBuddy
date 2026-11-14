"""Realtime six-stem worker. Native audio owns callbacks and bounded PCM rings."""
from __future__ import annotations

import argparse
import ctypes as ct
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

import numpy as np

RATE = 44100
PROFILES = {"smooth": (1200, 120, 100, 1000), "lowLatency": (420, 60, 20, 300)}
STEMS = ("drums", "bass", "other", "vocals", "guitar", "piano")


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=False, allow_nan=False), flush=True)


class Native:
    def __init__(self, path):
        self.lib = ct.CDLL(str(path))
        for name in ("bb_devices", "bb_open", "bb_stats"):
            getattr(self.lib, name).restype = ct.c_char_p
        self.lib.bb_open.argtypes = [ct.c_char_p]
        self.lib.bb_read.argtypes = [ct.POINTER(ct.c_float), ct.POINTER(ct.c_double), ct.c_uint]
        self.lib.bb_read.restype = ct.c_uint
        self.lib.bb_write.argtypes = [ct.POINTER(ct.c_float), ct.c_uint, ct.c_double, ct.c_double]
        self.lib.bb_write.restype = ct.c_uint
        self.samples = np.empty((8192, 2), np.float32)
        self.times = np.empty(8192, np.float64)

    def command(self, name, config=None):
        method = getattr(self.lib, name)
        value = method(json.dumps(config).encode()) if config is not None else method()
        result = json.loads(value)
        if isinstance(result, dict) and result.get("error"):
            error = result["error"]
            if error == "DEVICE_FORMAT_MUST_MATCH_RATE_FLOAT32":
                error = "设备格式不匹配，请在音频 MIDI 设置中将来源和输出设为相同的 44.1 或 48 kHz 立体声"
            elif error.startswith("COREAUDIO_ERROR_"):
                error = "无法打开 Core Audio 设备，请检查系统音频录制权限和设备连接（" + error + "）"
            elif error.startswith("WASAPI_ERROR_"):
                error = "无法访问所选音频设备，请检查连接、采样率以及是否被独占占用（" + error + "）"
            raise RuntimeError(error)
        return result

    def read(self):
        n = self.lib.bb_read(self.samples.ctypes.data_as(ct.POINTER(ct.c_float)),
                             self.times.ctypes.data_as(ct.POINTER(ct.c_double)), len(self.samples))
        return self.samples[:n].copy(), self.times[:n].copy()

    def write(self, samples, first_time, step):
        samples = np.ascontiguousarray(samples, dtype=np.float32)
        n = self.lib.bb_write(samples.ctypes.data_as(ct.POINTER(ct.c_float)), len(samples), first_time, step)
        if n != len(samples):
            raise RuntimeError("输出缓冲溢出，请重新测试")

    def close(self):
        self.lib.bb_close()


def combine(mix, estimates, sources, selected, mode):
    if len(selected) == len(sources):
        return np.zeros_like(mix) if mode == "remove" else mix.copy()
    chosen = estimates[[sources.index(name) for name in selected]].sum(axis=0)
    return mix - chosen if mode == "remove" else chosen


class DriftController:
    def __init__(self, rate):
        self.target = rate * .04
        self.remainder = 0.0

    def adjustment(self, queued, frames):
        # Observe the queue after inference, just before publishing a hop.
        # A bounded 2000 ppm correction follows independent device clocks;
        # it is too small to conceal missed inference deadlines.
        limit = frames * .002
        self.remainder += float(np.clip((queued - self.target) * .01, -limit, limit))
        adjustment = -int(self.remainder)
        self.remainder += adjustment
        return adjustment


class Separator:
    def __init__(self, model_root, device, profile):
        import torch
        from demucs.pretrained import get_model
        from worker import verified_bundle
        self.torch = torch
        torch.set_num_threads(min(4, max(1, os.cpu_count() or 1)))
        self.model = get_model("htdemucs_6s", repo=verified_bundle(Path(model_root), ("six_stem",)))
        if hasattr(self.model, "models"):
            self.model = self.model.models[0]
        self.model = self.model.eval().to(device)
        self.model.use_train_segment = False
        self.device = device
        p, h, r, _ = PROFILES[profile]
        self.past, self.hop, self.future = [round(n * RATE / 1000) for n in (p, h, r)]
        self.window = np.zeros((self.past + self.hop + self.future, 2), np.float32)
        self.fade = np.linspace(0, 1, RATE // 100, dtype=np.float32)[:, None]
        self.previous = None
        self.selection = None

    def step(self, data, selected, mode):
        self.window[:-self.hop] = self.window[self.hop:]
        self.window[-self.hop:] = data
        torch = self.torch
        end = self.past + self.hop + len(self.fade)
        with torch.inference_mode():
            x = torch.from_numpy(self.window.T.copy()).to(self.device)
            ref = x.mean(0)
            mean, std = ref.mean(), ref.std().clamp_min(1e-5)
            # Infer all six sources once, but transfer only the hop and fade
            # that will be played, not the entire historical context.
            estimates = (self.model(((x - mean) / std)[None])[0, :, :, self.past:end] * std + mean).cpu().numpy().transpose(0, 2, 1)
        dry = self.window[self.past:end]
        stems = estimates
        output = combine(dry, stems, self.model.sources, selected, mode)
        selection = (tuple(selected), mode)
        if self.selection is not None and selection != self.selection:
            old = combine(dry, stems, self.model.sources, *self.selection)
            output[:len(self.fade)] = old[:len(self.fade)] * (1 - self.fade) + output[:len(self.fade)] * self.fade
        elif self.previous is not None:
            output[:len(self.fade)] = self.previous * (1 - self.fade) + output[:len(self.fade)] * self.fade
        self.selection = selection
        self.previous = output[self.hop:].copy()
        return output[:self.hop]


def probe_signal(rate):
    n = (np.arange(rate, dtype=np.uint64) * RATE // rate).astype(np.uint32)
    x = n * np.uint32(747796405) + np.uint32(2891336453)
    x = ((x >> ((x >> 28) + 4)) ^ x) * np.uint32(277803737)
    x = (x >> 22) ^ x
    return ((x.astype(np.float64) / 4294967295 - .5) * .035).astype(np.float32)


def verify_probe(audio, rate):
    ref = np.tile(probe_signal(rate), 2)
    sample = audio[:rate // 4].mean(axis=1)
    power = float(np.dot(sample, sample))
    if power < 1e-8:
        return 0.0
    length = 1 << (len(ref) + len(sample) - 2).bit_length()
    convolution = np.fft.irfft(np.fft.rfft(ref, length) * np.fft.rfft(sample[::-1], length), length)
    dots = convolution[len(sample)-1:len(ref)]
    energy = np.r_[0., np.cumsum(ref.astype(float)**2)]
    denom = np.sqrt((energy[len(sample):] - energy[:-len(sample)]) * power)
    return float(np.max(dots / np.maximum(denom, 1e-12)))


def evaluate(stats, baseline, durations, profile, verified):
    _, hop, _, limit = PROFILES[profile]
    p99 = float(np.percentile(durations, 99)) if durations else 1e6
    maximum = float(max(durations, default=1e6))
    counts = {k: max(0, stats.get(k, 0) - baseline.get(k, 0)) for k in ("inputDrops", "underruns", "overflows", "clockErrors")}
    latency = stats.get("maxLatencyMs", 0)
    passed = verified and bool(durations) and not any(counts.values()) and p99 <= hop * .8 and maximum <= hop and 0 < latency <= limit
    return {"passed": bool(passed), "p99Ms": p99, "maxMs": maximum, "latencyMs": latency,
            "signalVerified": bool(verified), **counts}


def run(args, native, config, commands):
    import soxr
    profile = config["profile"]
    separator = Separator(args.model_root, args.device, profile)
    selected, mode = config["stems"], config["mode"]
    emit("phase", phase="warming", message="正在预热模型（至少 5 秒）")
    start = time.monotonic()
    while time.monotonic() - start < 5:
        while not commands.empty():
            command = commands.get()
            if command["op"] == "stop":
                return
            if command["op"] == "mix":
                selected, mode = command["stems"], command["mode"]
        separator.step(np.zeros((separator.hop, 2), np.float32), selected, mode)
    separator.window.fill(0)
    separator.previous = None
    rate = config["rate"]
    native_config = {**config, "test": args.test, "excludePids": config.get("excludePids", []) + [os.getpid()]}
    native.command("bb_open", native_config)
    probe_process = None
    try:
        if args.test and config["source"] == "system-tap":
            probe_config = {**native_config, "probeOnly": True, "source": "probe"}
            probe_process = subprocess.Popen([sys.executable, __file__, "--native", args.native, "--probe", "--config", json.dumps(probe_config)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
        down = soxr.ResampleStream(rate, RATE, 2, quality="LQ")
        up = soxr.ResampleStream(RATE, rate, 2, quality="LQ")
        pcm = np.empty((0, 2), np.float32)
        input_times = np.empty(0, np.float64)
        input_start = 0
        output_position = 0
        raw_probe = np.empty((0, 2), np.float32)
        primed = False
        verified = not args.test
        durations = []
        baseline = None
        steady_start = None
        last_report = 0
        audio_start = time.monotonic()
        last_input = audio_start
        events = []
        last_underruns = 0
        high_latency_since = None
        drift = DriftController(rate)
        emit("phase", phase="testing" if args.test else "starting", message="正在检查音频链路")
        while True:
            while not commands.empty():
                command = commands.get()
                if command["op"] == "stop":
                    return
                if command["op"] == "mix":
                    selected, mode = command["stems"], command["mode"]
            now = time.monotonic()
            stats = native.command("bb_stats")
            if now - last_input > 5:
                raise RuntimeError("未收到音频，请检查来源路由、采集权限和设备状态")
            data, times = native.read()
            if len(data):
                last_input = now
                input_times = np.concatenate((input_times, times))
                if args.test and not verified:
                    raw_probe = np.concatenate((raw_probe, data))[-rate:]
                    if len(raw_probe) >= rate // 2:
                        verified = verify_probe(raw_probe, rate) >= .75
                    if now - audio_start > 10 and not verified:
                        raise RuntimeError("测试音未通过来源校验，请关闭来源直通并检查虚拟设备路由")
                pcm = np.concatenate((pcm, down.resample_chunk(data)))
                if len(pcm) > RATE * 2 or len(input_times) > rate * 4:
                    raise RuntimeError("推理速度不足，输入缓冲已达到上限，请重新测试")
            if not primed and len(pcm) >= separator.future:
                separator.window[-separator.future:] = pcm[:separator.future]
                pcm = pcm[separator.future:]
                primed = True
            if primed and len(pcm) >= separator.hop:
                before = time.perf_counter()
                out = up.resample_chunk(separator.step(pcm[:separator.hop], selected, mode))
                source_count = len(out)
                pcm = pcm[separator.hop:]
                # Measure after inference so compute time is not mistaken for
                # device drift and the 40 ms jitter reserve remains intact.
                if steady_start and len(out) > 2:
                    depth = native.command("bb_stats").get("outputFrames", 0)
                    adjustment = drift.adjustment(depth, len(out))
                    if adjustment:
                        grid = np.linspace(0, len(out)-1, len(out)+adjustment)
                        out = np.column_stack([np.interp(grid, np.arange(len(out)), out[:, c]) for c in range(2)]).astype(np.float32)
                if len(out):
                    # Retain capture timestamps until their corresponding audio
                    # is rendered, so resampler buffering is included in latency.
                    index = max(0, output_position - input_start)
                    if index + source_count > len(input_times):
                        raise RuntimeError("采集与输出时间戳失去对应关系")
                    first = float(input_times[index])
                    step = float((input_times[index+source_count-1] - first) / max(1, len(out)-1))
                    native.write(out, first, step)
                    output_position += source_count
                    trim = max(0, output_position - input_start - rate)
                    input_times = input_times[trim:]
                    input_start += trim
                duration = (time.perf_counter() - before) * 1000
                if baseline is not None:
                    durations.append(duration)
                    if len(durations) > 2000:
                        durations = durations[-2000:]
            else:
                time.sleep(.002)
            if baseline is None and stats.get("rendered", 0) > rate * 2 and verified:
                baseline = stats
                last_underruns = stats["underruns"]
                steady_start = now
                emit("phase", phase="testing" if args.test else "running", message="正在测试完整链路" if args.test else "实时分轨运行中")
            if now - audio_start > 30 and baseline is None:
                raise RuntimeError("音频链路未能进入稳定播放状态")
            if baseline is not None:
                if stats["underruns"] > last_underruns:
                    events.extend([now] * (stats["underruns"] - last_underruns))
                    last_underruns = stats["underruns"]
                events = [t for t in events if now - t <= 10]
                high = stats.get("latencyMs", 0) > PROFILES[profile][3]
                high_latency_since = (high_latency_since or now) if high else None
                if not args.test and (len(events) >= 3 or stats["overflows"] > baseline["overflows"] or stats["inputDrops"] > baseline["inputDrops"] or stats["clockErrors"] > baseline["clockErrors"] or (high_latency_since and now - high_latency_since >= 2)):
                    raise RuntimeError("运行负载超过实时播放条件，已停止，请重新性能测试")
                elapsed = now - steady_start
                if now - last_report >= .5:
                    emit("metrics", progress=min(1, elapsed / 60) if args.test else 1,
                         metrics=evaluate(stats, baseline, durations, profile, verified))
                    last_report = now
                if args.test and elapsed >= 60:
                    emit("result", result=evaluate(stats, baseline, durations, profile, verified))
                    return
    finally:
        if probe_process:
            probe_process.stdin.close()
            try:
                probe_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                probe_process.kill()
                probe_process.wait()
        native.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--native", required=True)
    parser.add_argument("--model-root")
    parser.add_argument("--device", choices=("cuda", "mps", "cpu"), default="cpu")
    parser.add_argument("--config")
    parser.add_argument("--devices", action="store_true")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    native = Native(args.native)
    if args.devices:
        emit("devices", devices=native.command("bb_devices"))
        return
    config = json.loads(args.config)
    if args.probe:
        native.command("bb_open", config)
        finished = threading.Event()
        def watch_parent():
            sys.stdin.readline()
            finished.set()
        threading.Thread(target=watch_parent, daemon=True).start()
        try:
            while not finished.is_set():
                native.command("bb_stats")
                time.sleep(.1)
        finally:
            native.close()
    commands = queue.Queue(maxsize=32)
    def read_commands():
        try:
            for line in sys.stdin:
                value = json.loads(line)
                commands.put(value, timeout=1)
                if value.get("op") == "stop":
                    return
        finally:
            commands.put({"op": "stop"})
    threading.Thread(target=read_commands, daemon=True).start()
    try:
        run(args, native, config, commands)
    finally:
        native.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", error=str(error))
        sys.exit(1)
