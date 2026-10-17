from __future__ import annotations

from dataclasses import asdict, dataclass
import gc
import hashlib
from pathlib import Path
import time
from typing import Callable, Mapping

import numpy as np
import torch
import torch.nn.functional as torch_functional
import yaml

from ._vendor.msst import BSRoformer, MelBandRoformer
from .specs import GuitarQuality, ModelSpec, config_path
from . import memory
from .roformer_core import resolve_device, _checkpoint_state, _linear_window, _demix_once


PassKey = tuple[str, int]
HQ6_PASSES: tuple[PassKey, ...] = (
    ("identity", 0),
    ("identity", 1),
    ("channel_swap", 0),
    ("channel_swap", 1),
    ("polarity", 0),
    ("polarity", 1),
)
HQ3_PASSES: tuple[PassKey, ...] = (
    ("identity", 0),
    ("channel_swap", 0),
    ("polarity", 0),
)
QUALITY_PASSES: Mapping[GuitarQuality, tuple[PassKey, ...]] = {
    "high": HQ6_PASSES,
    "balanced": HQ3_PASSES,
}
InferenceProgress = Callable[[float, str], None]


@dataclass(frozen=True)
class InferenceReport:
    architecture: str
    target: str
    quality: str
    chunk_size: int
    overlap: int
    big_shifts: int
    tta_variants: tuple[str, ...]
    passes: int
    amp_enabled: bool
    parameters: int
    seconds: float
    peak_cuda_bytes: int

    def to_dict(self) -> dict[str, object]:
        value = asdict(self)
        value["tta_variants"] = list(self.tta_variants)
        return value




def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_config(spec: ModelSpec) -> dict[str, object]:
    path = config_path(spec)
    if _sha256(path) != spec.config_sha256:
        raise RuntimeError(f"CONFIG_HASH_MISMATCH:{spec.key}:{path}")
    with path.open("r", encoding="utf-8") as handle:
        config = yaml.load(handle, Loader=yaml.FullLoader)
    if not isinstance(config, dict):
        raise RuntimeError(f"CONFIG_INVALID:{spec.key}")
    training = config.get("training")
    if not isinstance(training, dict) or training.get("target_instrument") != spec.target:
        raise RuntimeError(f"CONFIG_TARGET_MISMATCH:{spec.key}")
    return config


def _build_model(spec: ModelSpec, config: dict[str, object]) -> torch.nn.Module:
    kwargs = config.get("model")
    if not isinstance(kwargs, dict):
        raise RuntimeError(f"CONFIG_MODEL_MISSING:{spec.key}")
    if spec.architecture == "bs_roformer_shared":
        return BSRoformer(**kwargs)
    if spec.architecture == "mel_band_roformer":
        return MelBandRoformer(**kwargs)
    raise RuntimeError(f"ARCHITECTURE_UNSUPPORTED:{spec.architecture}")








def _augment(mix: np.ndarray, variant: str) -> np.ndarray:
    if variant == "identity":
        return mix
    if variant == "channel_swap":
        return mix[::-1].copy()
    if variant == "polarity":
        return -mix
    raise ValueError(f"UNKNOWN_TTA_VARIANT:{variant}")


def _undo_augment(estimate: np.ndarray, variant: str) -> np.ndarray:
    if variant == "identity":
        return estimate
    if variant == "channel_swap":
        return np.flip(estimate, axis=-2).copy()
    if variant == "polarity":
        return -estimate
    raise ValueError(f"UNKNOWN_TTA_VARIANT:{variant}")


def _predict_passes(
    model: torch.nn.Module,
    mix: np.ndarray,
    *,
    chunk_size: int,
    overlap: int,
    use_amp: bool,
    device: torch.device,
    passes: tuple[PassKey, ...],
    num_stems: int,
    progress: InferenceProgress | None,
) -> np.ndarray:
    shape = (num_stems, *mix.shape) if num_stems > 1 else mix.shape
    accumulation = memory.zeros(shape)
    shift_size = mix.shape[-1] // 2
    policy_name = f"HQ{len(passes)}"

    for pass_index, (variant, shift_index) in enumerate(passes):
        augmented = _augment(mix, variant)
        shift = shift_index * shift_size
        shifted = np.roll(augmented, shift, axis=-1) if shift else augmented

        def report_pass(fraction: float, message: str) -> None:
            if progress:
                progress(
                    (pass_index + fraction) / len(passes),
                    f"{policy_name} {variant} {shift_index + 1} · {message}",
                )

        estimate = _demix_once(
            model,
            shifted,
            chunk_size=chunk_size,
            overlap=overlap,
            use_amp=use_amp,
            device=device,
            progress=report_pass,
            num_stems=num_stems,
        )
        if shift:
            estimate = np.roll(estimate, -shift, axis=-1)
        accumulation += _undo_augment(estimate, variant)
    accumulation /= float(len(passes))
    return memory.contiguous(accumulation)


def _high_quality_predict(
    model: torch.nn.Module,
    mix: np.ndarray,
    *,
    chunk_size: int,
    overlap: int,
    use_amp: bool,
    device: torch.device,
    progress: InferenceProgress | None,
) -> np.ndarray:
    return _predict_passes(
        model,
        mix,
        chunk_size=chunk_size,
        overlap=overlap,
        use_amp=use_amp,
        device=device,
        passes=HQ6_PASSES,
        num_stems=1,
        progress=progress,
    )


def _run_roformer(
    mix: np.ndarray,
    spec: ModelSpec,
    checkpoint_path: Path,
    device: torch.device,
    *,
    quality: GuitarQuality,
    num_stems: int,
    progress: InferenceProgress | None,
) -> tuple[np.ndarray, InferenceReport]:
    if quality == "fast":
        raise ValueError("ROFORMER_FAST_POLICY_UNSUPPORTED")
    config = load_config(spec)
    inference = config.get("inference")
    audio = config.get("audio")
    training = config.get("training")
    if not isinstance(inference, dict) or not isinstance(audio, dict) or not isinstance(training, dict):
        raise RuntimeError(f"CONFIG_SECTIONS_MISSING:{spec.key}")
    chunk_size = int(inference.get("chunk_size", audio["chunk_size"]))
    overlap = int(inference["num_overlap"])
    use_amp = bool(training.get("use_amp", True))
    passes = QUALITY_PASSES[quality]

    model = _build_model(spec, config)
    parameters = sum(parameter.numel() for parameter in model.parameters())
    if parameters != spec.trainable_parameters:
        raise RuntimeError(
            f"MODEL_PARAMETER_COUNT_MISMATCH:{spec.key}:expected={spec.trainable_parameters}:actual={parameters}"
        )
    state = _checkpoint_state(checkpoint_path)
    model.load_state_dict(state, strict=True)
    del state
    model.eval().requires_grad_(False).to(device)
    if device.type == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(device)

    started = time.perf_counter()
    try:
        estimate = _predict_passes(
            model,
            mix,
            chunk_size=chunk_size,
            overlap=overlap,
            use_amp=use_amp,
            device=device,
            passes=passes,
            num_stems=num_stems,
            progress=progress,
        )
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        seconds = time.perf_counter() - started
        peak_cuda_bytes = (
            int(torch.cuda.max_memory_allocated(device)) if device.type == "cuda" else 0
        )
    finally:
        model.to("cpu")
        del model
        gc.collect()
        if device.type == "cuda":
            torch.cuda.empty_cache()

    variants = tuple(dict.fromkeys(variant for variant, _ in passes))
    report = InferenceReport(
        architecture=spec.architecture,
        target=spec.target,
        quality=quality,
        chunk_size=chunk_size,
        overlap=overlap,
        big_shifts=2 if any(shift for _, shift in passes) else 1,
        tta_variants=variants,
        passes=len(passes),
        amp_enabled=use_amp and device.type == "cuda",
        parameters=parameters,
        seconds=seconds,
        peak_cuda_bytes=peak_cuda_bytes,
    )
    return estimate, report


def predict_model(
    mix: np.ndarray,
    spec: ModelSpec,
    checkpoint_path: Path,
    device: torch.device,
    progress: InferenceProgress | None = None,
    *,
    quality: GuitarQuality = "high",
) -> tuple[np.ndarray, InferenceReport]:
    return _run_roformer(
        mix,
        spec,
        checkpoint_path,
        device,
        quality=quality,
        num_stems=1,
        progress=progress,
    )


def predict_shared_bs(
    mix: np.ndarray,
    spec: ModelSpec,
    checkpoint_path: Path,
    device: torch.device,
    progress: InferenceProgress | None = None,
    *,
    quality: GuitarQuality = "high",
) -> tuple[np.ndarray, InferenceReport]:
    if spec.architecture != "bs_roformer_shared":
        raise ValueError(f"EXPECTED_SHARED_BS_SPEC:{spec.key}")
    return _run_roformer(
        mix,
        spec,
        checkpoint_path,
        device,
        quality=quality,
        num_stems=2,
        progress=progress,
    )
