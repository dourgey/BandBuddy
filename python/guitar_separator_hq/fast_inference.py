from __future__ import annotations

from dataclasses import asdict, dataclass
import gc
import os
from pathlib import Path
import time
from typing import Callable, Sequence

import numpy as np
import torch
import torch.nn.functional as torch_functional

from .inference import load_config
from .specs import ModelSpec
from . import memory


InferenceProgress = Callable[[float, str], None]


@dataclass(frozen=True)
class FastInferenceReport:
    architecture: str
    target: str
    quality: str
    seconds: float
    parameters: int
    device: str
    provider_requested: str | None = None
    providers_active: tuple[str, ...] = ()
    chunk_size: int = 0
    overlap: float = 0.0
    batch_size: int = 1
    peak_cuda_bytes: int = 0

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def select_onnx_providers(
    device: torch.device,
    available: Sequence[str],
) -> tuple[str, ...]:
    """Choose only providers shipped by the installed, platform-specific wheel."""

    providers = set(available)
    if device.type == "cuda" and "CUDAExecutionProvider" in providers:
        return ("CUDAExecutionProvider", "CPUExecutionProvider")
    if device.type == "mps" and "CoreMLExecutionProvider" in providers:
        return ("CoreMLExecutionProvider", "CPUExecutionProvider")
    if "CPUExecutionProvider" not in providers:
        raise RuntimeError(f"ONNXRUNTIME_CPU_PROVIDER_MISSING:{sorted(providers)}")
    return ("CPUExecutionProvider",)


def _create_onnx_session(model_path: Path, device: torch.device):
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError("ONNXRUNTIME_NOT_INSTALLED") from error

    if device.type == "cuda" and hasattr(ort, "preload_dlls"):
        # Reuse the CUDA/cuDNN libraries bundled by the already imported PyTorch.
        ort.preload_dlls()
    requested = select_onnx_providers(device, ort.get_available_providers())
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = max(1, int(os.environ.get("BANDBUDDY_CPU_THREADS", "2")))
    options.inter_op_num_threads = 1
    try:
        session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=list(requested),
        )
    except Exception:
        if requested[0] == "CPUExecutionProvider":
            raise
        session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
    active = tuple(session.get_providers())
    if requested[0] not in active and requested[0] != "CPUExecutionProvider":
        session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        active = tuple(session.get_providers())
    return session, requested[0], active


class _MdxStft:
    def __init__(self, n_fft: int, hop_length: int, dim_f: int, device: torch.device):
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.dim_f = dim_f
        # MPS still lacks several complex operators used by STFT/iSTFT. CoreML
        # inference remains accelerated while spectral transforms safely use CPU.
        self.device = torch.device("cpu") if device.type == "mps" else device
        self.window = torch.hann_window(n_fft, periodic=True, device=self.device)

    def forward(self, waveform: np.ndarray) -> torch.Tensor:
        tensor = torch.from_numpy(waveform).to(self.device)
        batch_dimensions = tensor.shape[:-2]
        channels, frames = tensor.shape[-2:]
        transformed = torch.stft(
            tensor.reshape(-1, frames),
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            window=self.window,
            center=True,
            return_complex=True,
        )
        real = torch.view_as_real(transformed).permute(0, 3, 1, 2)
        shaped = real.reshape(
            *batch_dimensions,
            channels * 2,
            real.shape[-2],
            real.shape[-1],
        )
        return shaped[..., : self.dim_f, :]

    def inverse(self, spectrum: np.ndarray) -> np.ndarray:
        tensor = torch.from_numpy(np.ascontiguousarray(spectrum)).to(self.device)
        batch_dimensions = tensor.shape[:-3]
        doubled_channels, frequencies, frames = tensor.shape[-3:]
        bins = self.n_fft // 2 + 1
        if frequencies < bins:
            tensor = torch_functional.pad(tensor, (0, 0, 0, bins - frequencies))
        shaped = tensor.reshape(*batch_dimensions, doubled_channels // 2, 2, bins, frames)
        flattened = shaped.reshape(-1, 2, bins, frames).permute(0, 2, 3, 1).contiguous()
        complex_tensor = torch.view_as_complex(flattened)
        waveform = torch.istft(
            complex_tensor,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            window=self.window,
            center=True,
        )
        return waveform.reshape(*batch_dimensions, 2, -1).float().cpu().numpy()


def predict_mdx(
    mix: np.ndarray,
    spec: ModelSpec,
    model_path: Path,
    device: torch.device,
    progress: InferenceProgress | None = None,
) -> tuple[np.ndarray, FastInferenceReport]:
    if spec.architecture != "mdx_net":
        raise ValueError(f"EXPECTED_MDX_SPEC:{spec.key}")
    config = load_config(spec)
    model_config = config["model"]
    inference = config["inference"]
    if not isinstance(model_config, dict) or not isinstance(inference, dict):
        raise RuntimeError(f"CONFIG_INVALID:{spec.key}")

    dim_f = int(model_config["dim_f"])
    dim_t = int(model_config["dim_t"])
    n_fft = int(model_config["n_fft"])
    hop_length = int(model_config["hop_length"])
    overlap = float(inference["overlap"])
    trim = n_fft // 2
    chunk_size = hop_length * (dim_t - 1)
    generated_size = chunk_size - 2 * trim
    pad = generated_size + trim - (mix.shape[-1] % generated_size)
    mixture = np.concatenate(
        (
            np.zeros((2, trim), dtype=np.float32),
            np.ascontiguousarray(mix, dtype=np.float32),
            np.zeros((2, pad), dtype=np.float32),
        ),
        axis=1,
    )
    step = int((1.0 - overlap) * chunk_size)
    starts = list(range(0, mixture.shape[-1], step))
    result = memory.zeros((2, mixture.shape[-1]))
    divider = memory.zeros(result.shape)

    session, requested_provider, active_providers = _create_onnx_session(model_path, device)
    input_name = session.get_inputs()[0].name
    stft = _MdxStft(n_fft, hop_length, dim_f, device)
    if device.type == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(device)
        torch.cuda.synchronize(device)

    started = time.perf_counter()
    try:
        for index, start in enumerate(starts):
            end = min(start + chunk_size, mixture.shape[-1])
            actual = end - start
            part = mixture[:, start:end]
            if actual < chunk_size:
                part = np.pad(part, ((0, 0), (0, chunk_size - actual)))
            spectrum = stft.forward(part[None])
            spectrum[..., :3, :] = 0
            predicted = session.run(
                None,
                {input_name: spectrum.detach().float().cpu().numpy()},
            )[0]
            waveform = stft.inverse(predicted)[0, :, :actual]
            window = np.hanning(actual).astype(np.float32, copy=False)
            result[:, start:end] += waveform * window[None]
            divider[:, start:end] += window[None]
            if progress:
                progress((index + 1) / len(starts), "MDX-Net 分块推理")
        for start in range(0, result.shape[-1], memory.BLOCK_FRAMES):
            end = start + memory.BLOCK_FRAMES
            valid = divider[:, start:end] > 1e-10
            np.divide(result[:, start:end], divider[:, start:end], out=result[:, start:end], where=valid)
            result[:, start:end][~valid] = 0
        estimate = memory.contiguous(result[:, trim:-trim][:, : mix.shape[-1]])
        if not np.isfinite(estimate).all():
            raise RuntimeError(f"MODEL_OUTPUT_NON_FINITE:{spec.key}")
        if device.type == "cuda":
            torch.cuda.synchronize(device)
            peak_cuda_bytes = int(torch.cuda.max_memory_allocated(device))
        else:
            peak_cuda_bytes = 0
        seconds = time.perf_counter() - started
    finally:
        del session, stft
        gc.collect()
        if device.type == "cuda":
            torch.cuda.empty_cache()

    report = FastInferenceReport(
        architecture=spec.architecture,
        target=spec.target,
        quality="fast-preview",
        seconds=seconds,
        parameters=spec.trainable_parameters,
        device=str(device),
        provider_requested=requested_provider,
        providers_active=active_providers,
        chunk_size=chunk_size,
        overlap=overlap,
        batch_size=1,
        peak_cuda_bytes=peak_cuda_bytes,
    )
    return estimate, report


def adaptive_htdemucs_batch_size(device: torch.device) -> int:
    if device.type == "cuda":
        # Other apps share the GPU: installed VRAM is not the available budget.
        try:
            available, _total = torch.cuda.mem_get_info(device)
        except (AttributeError, RuntimeError):
            available = torch.cuda.get_device_properties(device).total_memory // 2
        gib = available / (1024**3)
        if gib >= 4.0:
            return 8
        if gib >= 2.5:
            return 4
        return 1
    if device.type == "mps":
        return 2
    return 1


def _checkpoint_state(path: Path) -> dict[str, torch.Tensor]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict):
        raise RuntimeError(f"CHECKPOINT_STATE_INVALID:{path}")
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


def _build_htdemucs(spec: ModelSpec, model_path: Path) -> tuple[torch.nn.Module, dict[str, object]]:
    from demucs.htdemucs import HTDemucs

    config = load_config(spec)
    training = config["training"]
    model_config = config["htdemucs"]
    if not isinstance(training, dict) or not isinstance(model_config, dict):
        raise RuntimeError(f"CONFIG_INVALID:{spec.key}")
    model = HTDemucs(
        sources=list(training["instruments"]),
        samplerate=int(training["samplerate"]),
        segment=float(training["segment"]),
        use_train_segment=False,
        **model_config,
    )
    state = _checkpoint_state(model_path)
    model.load_state_dict(state, strict=True)
    del state
    return model, config


def _run_htdemucs_chunks(
    model: torch.nn.Module,
    mix: np.ndarray,
    device: torch.device,
    *,
    chunk_size: int,
    overlap: int,
    batch_size: int,
    progress: InferenceProgress | None,
) -> np.ndarray:
    step = chunk_size // overlap
    starts = list(range(0, mix.shape[-1], step))
    result = torch.from_numpy(memory.zeros((2, 2, mix.shape[-1])))
    counter = torch.from_numpy(memory.zeros(mix.shape[-1]))

    with torch.inference_mode():
        for batch_start in range(0, len(starts), batch_size):
            selected = starts[batch_start : batch_start + batch_size]
            parts: list[torch.Tensor] = []
            lengths: list[int] = []
            for start in selected:
                part = torch.from_numpy(mix[:, start : start + chunk_size])
                length = part.shape[-1]
                parts.append(torch_functional.pad(part, (0, chunk_size - length)))
                lengths.append(length)
            batch = torch.stack(parts).to(device)
            predicted = model(batch).float().cpu()
            if predicted.ndim != 4 or tuple(predicted.shape[1:3]) != (2, 2):
                raise RuntimeError(f"MODEL_OUTPUT_SHAPE_INVALID:{tuple(predicted.shape)}")
            for index, (start, length) in enumerate(zip(selected, lengths)):
                result[..., start : start + length] += predicted[index, ..., :length]
                counter[start : start + length] += 1.0
            if progress:
                completed = min(len(starts), batch_start + len(selected))
                progress(completed / len(starts), "HTDemucs 分块推理")
    return memory.divide_in_place(result.numpy(), counter.numpy()[None, None])


def predict_htdemucs(
    mix: np.ndarray,
    spec: ModelSpec,
    model_path: Path,
    device: torch.device,
    progress: InferenceProgress | None = None,
) -> tuple[np.ndarray, FastInferenceReport]:
    if spec.architecture != "htdemucs":
        raise ValueError(f"EXPECTED_HTDEMUCS_SPEC:{spec.key}")
    model, config = _build_htdemucs(spec, model_path)
    training = config["training"]
    inference = config["inference"]
    if not isinstance(training, dict) or not isinstance(inference, dict):
        raise RuntimeError(f"CONFIG_INVALID:{spec.key}")
    chunk_size = int(training["samplerate"]) * int(training["segment"])
    overlap = int(inference["num_overlap"])
    batch_size = adaptive_htdemucs_batch_size(device)
    parameters = sum(parameter.numel() for parameter in model.parameters())
    model.eval().requires_grad_(False).to(device)

    if device.type == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(device)
        torch.cuda.synchronize(device)
    started = time.perf_counter()
    try:
        try:
            while True:
                try:
                    sources = _run_htdemucs_chunks(model, mix, device, chunk_size=chunk_size,
                        overlap=overlap, batch_size=batch_size, progress=progress)
                    break
                except RuntimeError as error:
                    if device.type != "cuda" or batch_size <= 1 or "out of memory" not in str(error).lower():
                        raise
                    batch_size = max(1, batch_size // 2)
                    # Release tensors held by the failed call's traceback before retrying.
                    error.__traceback__ = None
                    gc.collect()
                    torch.cuda.empty_cache()
                    if progress:
                        progress(0.0, f"显存紧张，调整批量为 {batch_size} 后重试")
        except (NotImplementedError, RuntimeError) as error:
            if device.type != "mps":
                raise
            # A number of macOS/PyTorch combinations still omit complex MPS ops.
            # Retry this small model on CPU while keeping MDX on CoreML.
            if "not implemented" not in str(error).lower() and "mps" not in str(error).lower():
                raise
            device = torch.device("cpu")
            batch_size = 1
            model.to(device)
            sources = _run_htdemucs_chunks(
                model,
                mix,
                device,
                chunk_size=chunk_size,
                overlap=overlap,
                batch_size=batch_size,
                progress=progress,
            )
        if sources.shape != (2, 2, mix.shape[-1]) or not np.isfinite(sources).all():
            raise RuntimeError(f"MODEL_OUTPUT_INVALID:{spec.key}:{sources.shape}")
        if device.type == "cuda":
            torch.cuda.synchronize(device)
            peak_cuda_bytes = int(torch.cuda.max_memory_allocated(device))
        else:
            peak_cuda_bytes = 0
        seconds = time.perf_counter() - started
    finally:
        model.to("cpu")
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    report = FastInferenceReport(
        architecture=spec.architecture,
        target=spec.target,
        quality="fast-preview",
        seconds=seconds,
        parameters=parameters,
        device=str(device),
        chunk_size=chunk_size,
        overlap=float(overlap),
        batch_size=batch_size,
        peak_cuda_bytes=peak_cuda_bytes,
    )
    # Source order is pinned by the audited config: lead, then rhythm.
    return np.ascontiguousarray(sources[0], dtype=np.float32), report
