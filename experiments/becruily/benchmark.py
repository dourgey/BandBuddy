"""Reproducible CUDA benchmarks against the exact shipped becruily weights.

No flash-attn installation, compilation, model configuration or app DB changes.
"""
from __future__ import annotations
import argparse
import gc
import json
from pathlib import Path
import statistics
import sys
import time
import types

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from guitar_separator_hq._vendor.msst import BSRoformer
from guitar_separator_hq._vendor.msst.attend import Attend
from guitar_separator_hq.roformer_core import _checkpoint_state, _demix_once
from vocal_separator.separator import model_spec, digest, split_arrays


def difference(candidate, reference):
    delta = candidate.astype(np.float64)-reference.astype(np.float64)
    return {"maxAbsDifference": float(np.max(np.abs(delta))),
            "referenceDifferenceSnrDb": float(10*np.log10(max(np.sum(reference.astype(np.float64)**2),1e-30)/max(np.sum(delta**2),1e-30)))}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, default=ROOT / "output/singer-informed-20261114/duet-01/input_vocals.wav")
    p.add_argument("--output", type=Path, default=ROOT / "output/becruily-20261114")
    p.add_argument("--model-root", type=Path, default=Path.home()/"AppData/Local/BandBuddy/envs/models")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--variants", nargs="*")
    p.add_argument("--reference", type=Path)
    p.add_argument("--short-warmup", action="store_true", help="Warm the kernel on one chunk before long-file measurement")
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    spec = model_spec("bs-karaoke-frazer-becruily")
    checkpoint = args.model_root / "vocal-split-v1" / spec["id"] / spec["filename"]
    assert digest(checkpoint) == spec["sha256"]
    config = yaml.load((ROOT/"python/vocal_separator/configs"/spec["config"]).read_text(), Loader=yaml.FullLoader)
    audio, sr = sf.read(args.input, always_2d=True, dtype="float32")
    assert sr == 44100 and audio.shape[1] == 2
    audio = audio.T.copy()
    default_threads = torch.get_num_threads()
    torch.set_num_threads(4)
    started = time.perf_counter()
    model = BSRoformer(**config["model"])
    model.load_state_dict(_checkpoint_state(checkpoint), strict=True)
    model.eval().requires_grad_(False).cuda()
    torch.cuda.synchronize()
    load_seconds = time.perf_counter()-started
    originals = {m: m.flash_attn for m in model.modules() if isinstance(m, Attend)}
    def auto_sdpa(self, q, k, v):
        return F.scaled_dot_product_attention(q, k, v, dropout_p=0.)
    variants = [
        ("baseline-b2-t8", 20, 4, 2, default_threads, "legacy"),
        ("batch1-t4", 20, 4, 1, 4, "legacy"),
        ("batch2-t4", 20, 4, 2, 4, "legacy"),
        ("batch4-t4", 20, 4, 4, 4, "legacy"),
        ("sdpa-auto-b2", 20, 4, 2, 4, "auto"),
        ("overlap2-b2", 20, 2, 2, 4, "legacy"),
        ("overlap3-b2", 20, 3, 2, default_threads, "legacy"),
        ("chunk10-b2", 10, 4, 2, 4, "legacy"),
        ("grouped-b2-t8", 20, 4, 2, default_threads, "grouped"),
    ]
    if args.variants:
        variants = [v for v in variants if v[0] in args.variants]
    report = {"torch": torch.__version__, "gpu": torch.cuda.get_device_name(),
              "flashCompiled": torch.backends.cuda.is_flash_attention_available(),
              "input": str(args.input.resolve()), "inputSha256": digest(args.input),
              "durationSeconds": audio.shape[-1]/sr, "loadSeconds": load_seconds,
              "parameters": sum(p.numel() for p in model.parameters()),
              "parameterGroups": {name: sum(p.numel() for p in module.parameters()) for name,module in model.named_children()},
              "modelSha256": spec["sha256"], "results": []}
    baseline = sf.read(args.reference, dtype="float32", always_2d=True)[0].T.copy() if args.reference else None
    for name, chunk_seconds, overlap, batch, threads, backend in variants:
        torch.set_num_threads(threads)
        for mod, original in originals.items():
            mod.flash_attn = types.MethodType(auto_sdpa, mod) if backend == "auto" else original
        if backend == "grouped":
            from grouped_bands import install
            install(model)
        settings = dict(chunk_size=sr*chunk_seconds, overlap=overlap, batch_size=batch,
                        use_amp=True, device=torch.device("cuda"), progress=None)
        row = dict(name=name, chunkSeconds=chunk_seconds, overlap=overlap, batch=batch, threads=threads,
                   sdpa=backend, precision="autocast-fp16")
        try:
            warm = _demix_once(model, audio[:, :min(audio.shape[-1], 44100)] if args.short_warmup else audio, **settings)
            del warm
            times = []
            torch.cuda.reset_peak_memory_stats()
            for _ in range(args.repeats):
                torch.cuda.synchronize()
                started = time.perf_counter()
                prediction = _demix_once(model, audio, **settings)
                torch.cuda.synchronize()
                times.append(time.perf_counter()-started)
            row.update(seconds=times, medianSeconds=statistics.median(times),
                       peakCudaBytes=torch.cuda.max_memory_allocated(), peakReservedBytes=torch.cuda.max_memory_reserved())
            if baseline is None:
                baseline = prediction.copy()
            row.update(difference(prediction, baseline))
            lead, residual, error = split_arrays(audio, prediction)
            row["reconstructionMaxError"] = error
            folder = args.output/name
            folder.mkdir(exist_ok=True)
            sf.write(folder/"lead_vocals.wav", lead.T, sr, subtype="FLOAT")
            sf.write(folder/"backing_vocals.wav", residual.T, sr, subtype="FLOAT")
        except torch.cuda.OutOfMemoryError:
            row["error"] = "CUDA_OOM"
        report["results"].append(row)
        (args.output/"benchmark.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(row), flush=True)
        gc.collect()
        torch.cuda.empty_cache()
    print(json.dumps({"parameters": report["parameters"], "parameterGroups": report["parameterGroups"], "loadSeconds": load_seconds}), flush=True)


if __name__ == "__main__":
    main()
