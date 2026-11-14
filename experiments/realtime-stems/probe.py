"""Bounded-lookahead HTDemucs experiment. Run with BandBuddy's Python runtime."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from demucs.states import load_model


RATE = 44100
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "output/realtime-stems"
WEIGHT = "5c90dfd2-34c22ccb.th"
SHA256 = "34c22ccb381c6f9fdbf324f04e1e2fe21aaaf293f5ded163a162697ff9a02ddd"
# Past, emitted block, future in milliseconds. Past is zero-filled at startup.
PROFILES = {"fast": (420, 60, 20), "balanced": (1200, 120, 100), "quality": (2280, 240, 240)}


def model_for(device):
    path = Path(os.environ["LOCALAPPDATA"]) / "BandBuddy/envs/models/bandbuddy-stems-v2.0.1" / WEIGHT
    if hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
        raise ValueError("Unexpected Demucs checkpoint")
    torch.set_num_threads(4)
    return load_model(path).eval().to(device)


@torch.inference_mode()
def estimate(model, samples, stem):
    x = torch.from_numpy(np.ascontiguousarray(samples.T)).to(next(model.parameters()).device)
    mono = x.mean(0)
    mean, std = mono.mean(), mono.std().clamp_min(1e-5)
    y = model(((x - mean) / std)[None])[0, model.sources.index(stem)]
    return (y * std + mean).cpu().numpy().T


class Stream:
    def __init__(self, model, profile, stem="drums"):
        self.model, self.stem = model, stem
        self.past, self.hop, self.future = [round(ms * RATE / 1000) for ms in PROFILES[profile]]
        self.window = np.zeros((self.past + self.hop + self.future, 2), dtype=np.float32)
        self.fade = np.linspace(0, 1, min(RATE // 100, self.future), dtype=np.float32)[:, None]
        self.tail = None

    def step(self, new):
        # Window ends at the last received sample. At startup the caller primes
        # its last 'future' slots with the first input, then passes one hop.
        h, p, f = self.hop, self.past, len(self.fade)
        self.window[:-h] = self.window[h:]
        self.window[-h:] = new
        drum = estimate(self.model, self.window, self.stem)
        keep = self.window[p:p+h+f] - drum[p:p+h+f]
        if self.tail is not None:
            keep[:f] = self.tail * (1 - self.fade) + keep[:f] * self.fade
        self.tail = keep[h:].copy()
        return keep[:h]


def render(model, profile, samples, stem="drums"):
    stream = Stream(model, profile, stem)
    # EOF is the only time zero padding supplies future input.
    padded = np.pad(samples, ((0, stream.hop + stream.future), (0, 0)))
    stream.window[-stream.future:] = padded[:stream.future]
    chunks, timing = [], []
    for pos in range(0, len(samples), stream.hop):
        start = pos + stream.future
        t = time.perf_counter()
        chunks.append(stream.step(padded[start:start + stream.hop]))
        timing.append((time.perf_counter() - t) * 1000)
    return np.concatenate(chunks)[:len(samples)], np.asarray(timing)


def fixture():
    tracks = {}
    for name in ("drums", "bass", "other", "vocals"):
        x, sr = sf.read(DATA / f"{name}.wav", dtype="float32", always_2d=True)
        if sr != RATE or x.shape[1] != 2:
            raise ValueError("Expected 44.1 kHz stereo stems")
        tracks[name] = x
    bed = tracks["bass"] + tracks["other"] + tracks["vocals"]
    return bed + tracks["drums"], bed, tracks["drums"]


def metrics(output, bed, drums):
    # Fit the two reference signals jointly, then separately account for distortion.
    d, b, y = (x.astype(np.float64).ravel() for x in (drums, bed, output))
    gains = np.linalg.lstsq(np.column_stack((d, b)), y, rcond=None)[0]
    return {"drum_projection_db": float(20 * np.log10(max(abs(gains[0]), 1e-10))),
            "bed_projection_db": float(20 * np.log10(max(abs(gains[1]), 1e-10))),
            "error_improvement_db": float(10 * np.log10(np.dot(d, d) / np.sum((y - b)**2)))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    parser.add_argument("--music", type=Path, help="Optional 44.1 kHz stereo WAV for A/B and sustained timing")
    args = parser.parse_args()
    model = model_for(args.device)
    mix, bed, drums = fixture()
    ref = mix - estimate(model, mix, "drums")
    report = {"device": torch.cuda.get_device_name() if args.device == "cuda" else "CPU (4 threads)",
              "torch": torch.__version__, "track_seconds": len(mix) / RATE,
              "offline": metrics(ref, bed, drums), "profiles": {}}
    model.use_train_segment = False
    music = mix
    if args.music:
        music, rate = sf.read(args.music, dtype="float32", always_2d=True)
        if rate != RATE or music.shape[1] != 2:
            raise ValueError("Expected 44.1 kHz stereo music")
    for name, (_, hop_ms, _) in PROFILES.items():
        render(model, name, mix[:RATE // 2])  # warm this exact shape
        result, _ = render(model, name, mix)
        out, times = render(model, name, music)
        sf.write(DATA / f"{name}-{args.device}-drumless.wav", out, RATE, subtype="FLOAT")
        row = {**metrics(result, bed, drums), "timed_blocks": len(times), "timed_audio_s": len(music) / RATE,
               "p50_ms": float(np.median(times)), "p95_ms": float(np.percentile(times, 95)),
               "max_ms": float(times.max()), "over_hop": int((times > hop_ms).sum()),
               "rtf": float(np.mean(times) / hop_ms)}
        report["profiles"][name] = row
        print(name, row, flush=True)
    (DATA / f"benchmark-{args.device}.json").write_text(json.dumps(report, indent=2), encoding="utf8")


if __name__ == "__main__":
    main()
