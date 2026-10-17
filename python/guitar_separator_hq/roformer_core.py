"""Shared, gain-preserving RoFormer inference. Guitar policies remain in inference.py."""
from __future__ import annotations
from pathlib import Path
from typing import Callable
import numpy as np
import torch
import torch.nn.functional as torch_functional
from . import memory
InferenceProgress = Callable[[float, str], None]

def resolve_device(requested: str) -> torch.device:
    normalized = requested.strip().lower()
    if normalized == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda:0")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    device = torch.device(normalized)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    if device.type == "mps" and not (
        hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    ):
        raise RuntimeError("MPS_NOT_AVAILABLE")
    return device


def _checkpoint_state(path: Path) -> dict[str, torch.Tensor]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict):
        raise RuntimeError(f"CHECKPOINT_INVALID:{path}")
    for key in ("state", "state_dict", "model_state_dict"):
        nested = checkpoint.get(key)
        if isinstance(nested, dict):
            checkpoint = nested
            break
    if not checkpoint or not all(
        isinstance(key, str) and isinstance(value, torch.Tensor)
        for key, value in checkpoint.items()
    ):
        raise RuntimeError(f"CHECKPOINT_STATE_INVALID:{path}")
    return checkpoint


def _linear_window(chunk_size: int) -> torch.Tensor:
    fade_size = chunk_size // 10
    window = torch.ones(chunk_size, dtype=torch.float32)
    window[:fade_size] = torch.linspace(0.0, 1.0, fade_size)
    window[-fade_size:] = torch.linspace(1.0, 0.0, fade_size)
    return window


def _demix_once(
    model: torch.nn.Module,
    mix: np.ndarray,
    *,
    chunk_size: int,
    overlap: int,
    use_amp: bool,
    device: torch.device,
    progress: InferenceProgress | None,
    num_stems: int = 1,
    batch_size: int = 1,
) -> np.ndarray:
    if mix.ndim != 2 or mix.shape[0] != 2 or mix.shape[1] == 0:
        raise ValueError(f"EXPECTED_STEREO_CHANNEL_FIRST:{mix.shape}")
    if chunk_size <= 0 or overlap <= 0 or chunk_size // overlap <= 0:
        raise ValueError("INVALID_CHUNK_SETTINGS")
    if num_stems <= 0:
        raise ValueError("INVALID_STEM_COUNT")
    if not isinstance(batch_size, int) or batch_size <= 0:
        raise ValueError("INVALID_BATCH_SIZE")

    step = chunk_size // overlap
    border = chunk_size - step
    original_length = mix.shape[-1]
    padded = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32))
    used_border = original_length > 2 * border and border > 0
    if used_border:
        padded = torch_functional.pad(padded, (border, border), mode="reflect")

    window_template = _linear_window(chunk_size)
    result = torch.from_numpy(memory.zeros((num_stems, 2, padded.shape[-1])))
    counter = torch.from_numpy(memory.zeros(padded.shape[-1]))
    starts = list(range(0, padded.shape[-1], step))
    amp_enabled = use_amp and device.type == "cuda"

    with torch.inference_mode():
        for group_start in range(0, len(starts), max(1, batch_size)):
            group = starts[group_start:group_start + max(1, batch_size)]
            parts, lengths = [], []
            for start in group:
                part = padded[:, start:start + chunk_size]
                segment_length = part.shape[-1]
                missing = chunk_size - segment_length
                if missing:
                    pad_mode = "reflect" if segment_length > chunk_size // 2 else "constant"
                    part = torch_functional.pad(part, (0, missing), mode=pad_mode)
                parts.append(part)
                lengths.append(segment_length)
            batch = torch.stack(parts).to(device)
            with torch.autocast(device_type="cuda", dtype=torch.float16, enabled=amp_enabled):
                predicted = model(batch)
            if predicted.ndim == 3:
                predicted = predicted.unsqueeze(1)
            if predicted.ndim != 4 or tuple(predicted.shape[:3]) != (len(group), num_stems, 2):
                raise RuntimeError(f"MODEL_OUTPUT_SHAPE_INVALID:{tuple(predicted.shape)}")
            predicted = predicted.float().cpu()
            for offset, (start, segment_length) in enumerate(zip(group, lengths)):
                index = group_start + offset
                window = window_template.clone()
                if index == 0:
                    window[:chunk_size // 10] = 1.0
                if index == len(starts) - 1:
                    window[-chunk_size // 10:] = 1.0
                weights = window[:segment_length]
                result[..., start:start + segment_length] += predicted[offset, :, :, :segment_length] * weights
                counter[start:start + segment_length] += weights
            if progress:
                progress(min(1., (group_start + len(group)) / len(starts)), "分块推理")

    estimate = memory.divide_in_place(result.numpy(), counter.numpy()[None, None])
    if used_border:
        estimate = estimate[..., border:-border]
    estimate = estimate[..., :original_length]
    if not memory.finite(estimate):
        raise RuntimeError("MODEL_OUTPUT_NON_FINITE")
    estimate = memory.contiguous(estimate)
    return estimate[0] if num_stems == 1 else estimate
