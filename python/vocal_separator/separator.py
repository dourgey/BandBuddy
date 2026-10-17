"""Refine a saved vocal stem without changing its timeline or gain scale."""
from __future__ import annotations

import gc
import hashlib
import json
from pathlib import Path
import time
from typing import Callable

import numpy as np
import soundfile as sf
import torch
import yaml

from guitar_separator_hq._vendor.msst import BSRoformer, MelBandRoformer
from guitar_separator_hq.roformer_core import _checkpoint_state, _demix_once, resolve_device
from guitar_separator_hq.separator import load_audio, validate_audio_array, write_float_wav, audio_stats
from guitar_separator_hq import memory

SAMPLE_RATE = 44_100


def catalog_path() -> Path:
    root = Path(__file__).resolve().parents[2]
    candidates = (root / "vocal-model-catalog.json", root / "resources" / "vocal-model-catalog.json")
    return next((p for p in candidates if p.is_file()), candidates[-1])


def model_spec(model_id: str) -> dict:
    catalog = json.loads(catalog_path().read_text(encoding="utf-8"))
    spec = next((spec for spec in catalog["models"] if spec["id"] == model_id), None)
    if spec is None:
        raise ValueError("VOCAL_MODEL_UNKNOWN")
    return spec


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def split_arrays(vocals: np.ndarray, lead: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    vocals = validate_audio_array(vocals, name="vocals", frames=vocals.shape[-1])
    lead = validate_audio_array(lead, name="lead_vocals", frames=vocals.shape[-1])
    backing = memory.zeros(vocals.shape)
    error = 0.0
    for start in range(0, vocals.shape[-1], memory.BLOCK_FRAMES):
        end = start + memory.BLOCK_FRAMES
        backing[:, start:end] = vocals[:, start:end] - lead[:, start:end]
        error = max(error, float(np.max(np.abs(lead[:, start:end] + backing[:, start:end] - vocals[:, start:end]))))
    if not memory.finite(backing) or error > 1e-6 * max(1.0, audio_stats(vocals)["peak"]):
        raise RuntimeError("VOCAL_RECONSTRUCTION_FAILED")
    return lead, backing, error


def separate(input_path: Path, output: Path, model_root: Path, model_id: str, requested_device: str,
             progress: Callable[[float, str], None] | None = None, batch_override: int | None = None) -> dict:
    spec = model_spec(model_id)
    checkpoint = model_root / "vocal-split-v1" / model_id / spec["filename"]
    config_path = Path(__file__).parent / "configs" / spec["config"]
    if not checkpoint.is_file():
        raise RuntimeError("VOCAL_MODEL_MISSING")
    if checkpoint.stat().st_size != spec["size"] or digest(checkpoint) != spec["sha256"]:
        raise RuntimeError("VOCAL_MODEL_HASH_MISMATCH")
    if digest(config_path) != spec["configSha256"]:
        raise RuntimeError("VOCAL_CONFIG_HASH_MISMATCH")
    config = yaml.load(config_path.read_text(encoding="utf-8"), Loader=yaml.FullLoader)
    if config["audio"]["sample_rate"] != SAMPLE_RATE or config["audio"]["num_channels"] != 2 or config["model"]["num_stems"] != 1:
        raise RuntimeError("VOCAL_MODEL_CONFIG_INVALID")
    device = resolve_device(requested_device)
    model_class = MelBandRoformer if spec["architecture"] == "mel_band_roformer" else BSRoformer
    model = model_class(**config["model"])
    model.load_state_dict(_checkpoint_state(checkpoint), strict=True)
    model.eval().requires_grad_(False).to(device)
    vocals = load_audio(input_path)
    chunk = int(config["audio"]["chunk_size"])
    overlap = int(config["inference"]["num_overlap"])
    batch = int(config["inference"]["batch_size"]) if batch_override is None else batch_override
    if batch <= 0:
        raise ValueError("VOCAL_BATCH_SIZE_INVALID")
    started = time.perf_counter()
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    try:
        try:
            lead = _demix_once(model, vocals, chunk_size=chunk, overlap=overlap,
                               use_amp=bool(config["training"].get("use_amp", False)), device=device,
                               progress=progress, batch_size=batch)
        except torch.cuda.OutOfMemoryError:
            if batch <= 1:
                raise
            batch = 1
            torch.cuda.empty_cache()
            lead = None
        # Retry outside the exception context so its traceback releases tensors.
        if lead is None:
            lead = _demix_once(model, vocals, chunk_size=chunk, overlap=overlap,
                               use_amp=bool(config["training"].get("use_amp", False)), device=device,
                               progress=progress, batch_size=batch)
        lead, backing, error = split_arrays(vocals, lead)
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        output.mkdir(parents=True, exist_ok=True)
        files, stats = {}, {}
        for name, array in (("lead_vocals", lead), ("backing_vocals", backing)):
            target = output / f"{name}.wav"
            write_float_wav(target, array)
            info = sf.info(target)
            if info.frames != vocals.shape[-1] or info.samplerate != SAMPLE_RATE or info.channels != 2:
                raise RuntimeError("VOCAL_WRITTEN_FORMAT_INVALID")
            files[name], stats[name] = str(target), audio_stats(array)
        return dict(files=files, stats=stats, sampleRate=SAMPLE_RATE, channels=2, frames=vocals.shape[-1],
                    modelId=model_id, modelRevision=spec["revision"], modelSha256=spec["sha256"],
                    configSha256=spec["configSha256"], inputSha256=digest(input_path), device=str(device),
                    reconstructionMaxError=error, seconds=time.perf_counter()-started,
                    peakCudaBytes=torch.cuda.max_memory_allocated(device) if device.type == "cuda" else 0,
                    inference=dict(chunkSize=chunk, overlap=overlap, batchSize=batch, tta=False,
                                   normalize=False, amp=device.type == "cuda" and config["training"].get("use_amp", False)))
    finally:
        model.to("cpu")
        del model
        gc.collect()
        if device.type == "cuda":
            torch.cuda.empty_cache()


def verify_encoded(source: Path, lead: Path, backing: Path, gain: float, storage_format: str) -> dict:
    if not np.isfinite(gain) or not 0 < gain <= 1:
        raise ValueError("VOCAL_ENCODING_GAIN_INVALID")
    with sf.SoundFile(source) as v, sf.SoundFile(lead) as l, sf.SoundFile(backing) as b:
        if not (v.frames == l.frames == b.frames and v.frames > 0):
            raise RuntimeError("VOCAL_ENCODED_FRAME_MISMATCH")
        if any(f.samplerate != SAMPLE_RATE or f.channels != 2 for f in (v, l, b)):
            raise RuntimeError("VOCAL_ENCODED_FORMAT_INVALID")
        error, signal_power, error_power, peak = 0., 0., 0., 0.
        while True:
            original = v.read(memory.BLOCK_FRAMES, dtype="float32", always_2d=True)
            if not len(original):
                break
            main, harmony = l.read(len(original), dtype="float32", always_2d=True), b.read(len(original), dtype="float32", always_2d=True)
            if not all(np.isfinite(a).all() for a in (original, main, harmony)):
                raise RuntimeError("VOCAL_ENCODED_NON_FINITE")
            residual = (main + harmony) / gain - original
            error = max(error, float(np.max(np.abs(residual))))
            peak = max(peak, float(np.max(np.abs(main))), float(np.max(np.abs(harmony))))
            signal_power += float(np.sum(original.astype(np.float64)**2))
            error_power += float(np.sum(residual.astype(np.float64)**2))
        if storage_format == "flac24" and error > 1e-6 + 3 * 2**-23 / gain:
            raise RuntimeError("VOCAL_ENCODED_RECONSTRUCTION_FAILED")
        return dict(frames=v.frames, reconstructionMaxError=error, encodedPeak=peak,
                    reconstructionSnrDb=10 * np.log10(max(signal_power, 1e-30)/max(error_power, 1e-30)),
                    lossy=storage_format == "mp3_320")
