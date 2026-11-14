"""Local reference-conditioned vocal experiment; never writes the song database.

Uses the author's unmodified source and public checkpoints (see README.md).
Run with BandBuddy's managed Python, not the download-only tools environment.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import types

import numpy as np
import soundfile as sf
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from vocal_separator.separator import separate, split_arrays, verify_encoded

SR = 44100


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec)
    sys.modules[name] = obj
    spec.loader.exec_module(obj)
    return obj


def upstream_modules(upstream):
    # Load just the inference modules, avoiding the upstream CLI/training imports.
    package = types.ModuleType("singer_experiment_upstream")
    package.__path__ = [str(upstream / "open-unmix-pytorch/openunmix")]
    sys.modules[package.__name__] = package
    model = module(package.__name__ + ".model", Path(package.__path__[0]) / "model.py")
    encoder = module("singer_experiment_embedding", upstream / "singer_embedding/Customized_NetSV.py")
    return model, encoder


def load_model(kind, checkpoint_root, model_module, device):
    folder = checkpoint_root / (kind + "-dual-0.1")
    config = json.loads((folder / "vocals.json").read_text())["args"]
    state = torch.load(folder / "vocals.pth", map_location="cpu", weights_only=True)
    cls = model_module.OpenUnmix_Embedding if kind == "concat" else model_module.OpenUnmix_FiLM
    model = cls(nb_bins=config["nfft"] // 2 + 1, nb_channels=1,
                hidden_size=config["hidden_size"], max_bin=state["input_mean"].numel(), emb_dim=32)
    model.load_state_dict(state, strict=True)
    model.eval().requires_grad_(False).to(device)
    return model, config


def read(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != SR or audio.shape[1] != 2 or not np.isfinite(audio).all():
        raise ValueError("Expected finite stereo 44100 Hz WAV")
    return audio.T.copy()


def clip(audio, start, duration):
    part = audio[:, round(start * SR):round((start + duration) * SR)].copy()
    if part.shape[-1] != round(duration * SR):
        raise ValueError("Clip exceeds input")
    return part


def write(path, audio):
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio.T, SR, subtype="FLOAT")


def embedding(model, audio, device):
    mono = audio.mean(axis=0)
    if len(mono) != 3 * SR or np.max(np.abs(mono)) < 1e-5:
        raise ValueError("Enrollment must be three non-silent seconds")
    # Matches the author's peak normalization of enrollment only.
    tensor = torch.from_numpy(mono / np.max(np.abs(mono))).unsqueeze(0).to(device)
    with torch.inference_mode():
        return model.embedding(tensor)


def infer(model, config, audio, emb, device, stereo_mask=True):
    nfft, hop = config["nfft"], config["nhop"]
    wave = torch.from_numpy(audio).to(device)
    window = torch.hann_window(nfft, device=device)
    with torch.inference_mode():
        # Author model is mono. Predict from the waveform downmix exactly as in
        # the training pipeline; apply its shared real mask to both original
        # complex channels for the explicitly experimental stereo adaptation.
        mono = wave.mean(dim=0, keepdim=True)
        spec = torch.stft(mono, nfft, hop, window=window, return_complex=True)
        mag = spec.abs().unsqueeze(0)
        condition = emb.unsqueeze(1) if hasattr(model, "emb_dim") and model.__class__.__name__ == "OpenUnmix_Embedding" else emb
        estimate = model(mag, condition)[0]
        mask = torch.where(spec.abs() > 1e-10, estimate / spec.abs().clamp_min(1e-10), 0)
        if stereo_mask:
            source_spec = torch.stft(wave, nfft, hop, window=window, return_complex=True)
            target = torch.istft(source_spec * mask, nfft, hop, window=window, length=wave.shape[-1])
        else:
            target = torch.istft(spec * mask, nfft, hop, window=window, length=wave.shape[-1])
        result = target.float().cpu().numpy()
    if not np.isfinite(result).all():
        raise RuntimeError("Non-finite inference")
    return result


def audit(args):
    device = torch.device(args.device)
    model_module, _ = upstream_modules(args.upstream)
    result = {}
    torch.manual_seed(42)
    for kind in ("concat", "film"):
        model, config = load_model(kind, args.checkpoints, model_module, device)
        mag = torch.rand(1, 1, 2049, 64, device=device)
        emb1, emb2 = torch.randn(1, 32, device=device), torch.randn(1, 32, device=device)
        if kind == "concat":
            emb1, emb2 = emb1.unsqueeze(1), emb2.unsqueeze(1)
        with torch.inference_mode():
            a, b = model(mag, emb1), model(mag, emb2)
        result[kind] = dict(maxOutputDifference=float((a-b).abs().max()),
                            outputExactlyEqual=bool(torch.equal(a, b)),
                            inputBins=2049, internalBins=model.nb_bins, embeddingDims=32,
                            checkpointSha256=sha(args.checkpoints / (kind + "-dual-0.1") / "vocals.pth"))
        del model
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "conditioning-audit.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2), flush=True)


def pair(folder, source, lead):
    main, residual, error = split_arrays(source, lead)
    write(folder / "lead_vocals.wav", main)
    write(folder / "backing_vocals.wav", residual)
    return {"reconstructionMaxError": error,
            "rmsLead": float(np.sqrt(np.mean(main.astype(np.float64)**2))),
            "rmsResidual": float(np.sqrt(np.mean(residual.astype(np.float64)**2))),
            "peak": float(max(np.max(np.abs(main)), np.max(np.abs(residual))))}


def run(args):
    device = torch.device(args.device)
    audio = read(args.vocals)
    model_module, encoder_module = upstream_modules(args.upstream)
    encoder = encoder_module.NetSV(32, 2)
    encoder.load_state_dict(torch.load(args.checkpoints / "embedding-clean.pth", map_location="cpu", weights_only=True), strict=True)
    encoder.eval().requires_grad_(False).to(device)
    refs = {"male": clip(audio, args.male_ref, 3), "female": clip(audio, args.female_ref, 3)}
    embeddings = {name: embedding(encoder, ref, device) for name, ref in refs.items()}
    for name, ref in refs.items():
        write(args.output / "references" / (name + ".wav"), ref)
    result = dict(vocalInputSha256=sha(args.vocals), sourceFile=str(args.vocals.resolve()),
                  references={"male": [args.male_ref, args.male_ref+3], "female": [args.female_ref, args.female_ref+3]},
                  embeddingDistance=float(torch.linalg.vector_norm(embeddings["male"]-embeddings["female"])),
                  device=str(device), stereoAdaptation="mono waveform mask applied identically to original complex L/R spectra; unclipped mask",
                  subjectiveQualityAccepted=False, cases=[])
    cases = [("duet-01", args.start, args.duration)]
    if args.second_start is not None:
        cases.append(("duet-02", args.second_start, args.duration))
    # Reference neighborhoods may contain the other singer as they progress.
    # They are diagnostic controls, not absent-target or ground-truth stems.
    cases += [("male-solo-control", args.male_ref, 8), ("female-solo-control", args.female_ref, 8)]
    for name, start, duration in cases:
        folder = args.output / name
        source = clip(audio, start, duration)
        write(folder / "input_vocals.wav", source)
        report = dict(name=name, start=start, duration=duration, results={})
        for kind in ("concat", "film"):
            model, config = load_model(kind, args.checkpoints, model_module, device)
            predictions = {}
            for target, emb in embeddings.items():
                started = time.perf_counter()
                predictions[target] = infer(model, config, source, emb, device)
                stats = pair(folder / (kind + "-" + target), source, predictions[target])
                stats["seconds"] = time.perf_counter() - started
                report["results"][kind + "-" + target] = stats
            report[kind + "ReferenceSwitchMaxDifference"] = float(np.max(np.abs(predictions["male"]-predictions["female"])))
            report[kind + "ReferenceSwitchRelativeRms"] = float(np.linalg.norm(predictions["male"]-predictions["female"]) / max(np.linalg.norm(source), 1e-15))
            # Save the faithful mono version on the first case to separate stereo
            # adaptation effects from reference-model capability.
            if name == "duet-01":
                for target, emb in embeddings.items():
                    mono = infer(model, config, source, emb, device, stereo_mask=False)
                    write(folder / (kind + "-" + target) / "author_mono_target.wav", mono)
                    write(folder / (kind + "-" + target) / "author_mono_residual.wav", source.mean(axis=0, keepdims=True)-mono)
            del model
            gc.collect()
            if device.type == "cuda":
                torch.cuda.empty_cache()
        if not args.skip_baselines:
            for model_id in ("mel-karaoke-aufr33-viperx", "bs-karaoke-frazer-becruily"):
                report["results"][model_id] = separate(folder / "input_vocals.wav", folder / model_id,
                                                       args.model_root, model_id, args.device, batch_override=1)
        result["cases"].append(report)
        (args.output / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)


def export(args):
    """One common gain for every file; verify lossless pair reconstruction."""
    files = [p for p in args.output.rglob("*.wav") if "source" not in p.relative_to(args.output).parts or p.name == "vocals.wav"]
    peak = max(float(np.max(np.abs(sf.read(p, dtype="float32")[0]))) for p in files)
    gain = min(1., .95/max(peak, 1e-20))
    for path in files:
        subprocess.run([str(args.ffmpeg), "-y", "-v", "error", "-i", str(path), "-af", f"volume={gain:.12f}",
                        "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(path.with_suffix(".flac"))], check=True)
    checks = []
    for source in args.output.glob("*/input_vocals.wav"):
        for lead in source.parent.glob("*/lead_vocals.flac"):
            check = verify_encoded(source, lead, lead.with_name("backing_vocals.flac"), gain, "flac24")
            checks.append({"path": str(lead.relative_to(args.output)), **check})
    for lead in (args.output / "full-song").glob("*/lead_vocals.flac"):
        check = verify_encoded(args.vocals, lead, lead.with_name("backing_vocals.flac"), gain, "flac24")
        checks.append({"path": str(lead.relative_to(args.output)), **check})
    data = {"commonListeningGain": gain, "peakBeforeGain": peak, "checks": checks}
    (args.output / "export-verification.json").write_text(json.dumps(data, indent=2))
    print(json.dumps(data), flush=True)


def extract(args):
    """Exercise the existing worker file contract over a full saved vocal stem."""
    device = torch.device(args.device)
    source = read(args.vocals)
    model_module, encoder_module = upstream_modules(args.upstream)
    encoder = encoder_module.NetSV(32, 2).to(device)
    encoder.load_state_dict(torch.load(args.checkpoints / "embedding-clean.pth", map_location="cpu", weights_only=True), strict=True)
    encoder.eval().requires_grad_(False)
    model, config = load_model("film", args.checkpoints, model_module, device)
    result = {"inputSha256": sha(args.vocals), "modelSha256": sha(args.checkpoints / "film-dual-0.1/vocals.pth"),
              "sampleRate": SR, "channels": 2, "frames": source.shape[-1], "results": {}}
    for target, start in (("male", args.male_ref), ("female", args.female_ref)):
        condition = embedding(encoder, clip(source, start, 3), device)
        started = time.perf_counter()
        predicted = infer(model, config, source, condition, device)
        folder = args.output / "full-song" / ("film-" + target)
        stats = pair(folder, source, predicted)
        result["results"][target] = {**stats, "seconds": time.perf_counter()-started,
                                    "files": {name: str(folder / (name + ".wav")) for name in ("lead_vocals", "backing_vocals")}}
    (args.output / "full-song/results.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["audit", "run", "extract", "export"])
    p.add_argument("--upstream", type=Path, default=ROOT / ".tmp/singer-informed/upstream")
    p.add_argument("--checkpoints", type=Path, default=ROOT / ".tmp/singer-informed/checkpoints")
    p.add_argument("--output", type=Path, default=ROOT / "output/singer-informed-20261114")
    p.add_argument("--vocals", type=Path, default=ROOT / "output/singer-informed-20261114/source/vocals.wav")
    p.add_argument("--model-root", type=Path, default=Path.home() / "AppData/Local/BandBuddy/envs/models")
    p.add_argument("--ffmpeg", type=Path, default=ROOT / "resources/bin/ffmpeg.exe")
    p.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    p.add_argument("--male-ref", type=float, default=26)
    p.add_argument("--female-ref", type=float, default=41)
    p.add_argument("--start", type=float, default=68)
    p.add_argument("--duration", type=float, default=25)
    p.add_argument("--second-start", type=float, default=205)
    p.add_argument("--skip-baselines", action="store_true")
    args = p.parse_args()
    torch.set_num_threads(4)
    {"audit": audit, "run": run, "extract": extract, "export": export}[args.command](args)


if __name__ == "__main__":
    main()
