"""Offline Beat This inference and robust conversion from beat times to a fixed grid.

The confidence measures beat-interval/grid consistency, not a model probability.
The upstream wheel and checkpoint are verified by the Electron caller.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import sys


def summarize_beats(beats) -> dict | None:
    times = [float(value) for value in beats]
    if len(times) < 8 or any(not math.isfinite(t) or t < 0 for t in times):
        return None
    intervals = [b - a for a, b in zip(times, times[1:])]
    if any(value <= 0 for value in intervals):
        return None
    plausible = [value for value in intervals if 0.2 <= value <= 2.0]
    if len(plausible) < 7:
        return None
    initial = statistics.median(plausible)
    # Preserve the tracker pulse (including slow/fast music); do not fold octaves.
    indices = [0]
    for value in intervals:
        indices.append(indices[-1] + max(1, round(value / initial)))
    consistent = [abs(value / initial - round(value / initial)) < 0.1 for value in intervals]
    support = sum(consistent) / len(consistent)
    if support < 0.55:
        return None
    # Longer baselines remove the tracker's 20 ms frame quantization without
    # assuming every beat has been detected. Reject windows containing bad IOIs.
    periods = [(times[i + 8] - times[i]) / (indices[i + 8] - indices[i])
               for i in range(len(times) - 8) if all(consistent[i:i + 8])]
    period = statistics.median(periods) if periods else initial
    phase = times[0]
    # Robust regression refines decimal BPM and phase for a constant-tempo song.
    # Variable-tempo tracks retain a representative median pulse, with lower
    # confidence when no single fixed grid can represent them.
    for _ in range(4):
        angles = [2 * math.pi * ((t / period) % 1) for t in times]
        phase = math.atan2(sum(map(math.sin, angles)), sum(map(math.cos, angles))) / (2 * math.pi) * period
        pairs = [(round((t - phase) / period), t) for t in times
                 if abs((t - phase + period / 2) % period - period / 2) <= min(0.08, period * 0.15)]
        if len(pairs) < max(8, len(times) * 0.55):
            break
        mx = statistics.mean(x for x, _ in pairs)
        my = statistics.mean(y for _, y in pairs)
        denominator = sum((x - mx) ** 2 for x, _ in pairs)
        if denominator == 0:
            break
        refined = sum((x - mx) * (y - my) for x, y in pairs) / denominator
        if not 0.97 <= refined / period <= 1.03:
            break
        period = refined
    bpm = round(60 / period, 1)
    if not 30 <= bpm <= 300:
        return None
    # Use the persisted, rounded BPM when deriving its corresponding phase.
    period = 60 / bpm
    angles = [2 * math.pi * ((t / period) % 1) for t in times]
    x, y = sum(map(math.cos, angles)), sum(map(math.sin, angles))
    coherence = math.hypot(x, y) / len(times)
    phase = math.atan2(y, x) / (2 * math.pi) * period
    confidence = min(1.0, support * (0.5 + 0.5 * coherence) * min(1.0, (len(times) - 1) / 24))
    return {"bpm": bpm, "beatOffsetMs": round(phase * 1000),
            "confidence": round(confidence, 4), "beatCount": len(times)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    args = parser.parse_args()
    # A wheel is a zip-importable pure Python package: no pip install or changes
    # to the immutable separation environment are necessary.
    sys.path.insert(0, str(Path(args.package).resolve()))
    import numpy as np
    import soundfile as sf
    import torch
    from beat_this.inference import Audio2Beats

    torch.set_num_threads(max(1, min(8, int(os.environ.get("BANDBUDDY_CPU_THREADS", "4")))))
    info = sf.info(args.audio)
    if info.samplerate != 22050 or info.channels != 1 or info.duration > 1800:
        raise ValueError("BPM_AUDIO_LIMIT:expected mono 22050 Hz, at most 30 minutes")
    audio, sr = sf.read(args.audio, dtype="float32")
    if len(audio) < sr * 4 or not np.isfinite(audio).all() or np.max(np.abs(audio), initial=0) < 1e-6:
        print(json.dumps({"type": "result", "analysis": None}))
        return
    device = args.device
    try:
        tracker = Audio2Beats(checkpoint_path=args.checkpoint, device=device, dbn=False)
        beats, _downbeats = tracker(audio, sr)
    except (RuntimeError, NotImplementedError):
        if device == "cpu":
            raise
        # Unsupported GPU kernels or exhausted GPU memory still allow local CPU
        # inference; release the first model before retrying.
        import gc
        tracker = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        device = "cpu"
        tracker = Audio2Beats(checkpoint_path=args.checkpoint, device=device, dbn=False)
        beats, _downbeats = tracker(audio, sr)
    print(json.dumps({"type": "result", "analysis": summarize_beats(beats), "device": device}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"type": "error", "message": str(error)}), flush=True)
        raise
