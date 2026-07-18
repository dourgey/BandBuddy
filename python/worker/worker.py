#!/usr/bin/env python3
"""BandBuddy's isolated Demucs worker.

The process protocol is JSON Lines on stdout. Logs belong on stderr. Every command
is intentionally finite so the Electron process can cancel it by terminating this
process without leaving a local service or open port behind.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import platform
import traceback
from typing import Any


PROTOCOL_VERSION = 1
MODEL_NAME = "htdemucs_6s"
STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")


def emit(kind: str, **payload: Any) -> None:
    print(json.dumps({"protocol": PROTOCOL_VERSION, "type": kind, **payload}, ensure_ascii=False), flush=True)


def verified_model_repository(model_root: Path) -> Path:
    from model_download import verify_model

    return verify_model(MODEL_NAME, model_root)


def command_ensure_model(args: argparse.Namespace) -> None:
    from model_download import download_model

    model_root = Path(args.model_root).resolve()
    target = download_model(
        MODEL_NAME,
        model_root,
        progress=lambda progress, message: emit(
            "progress", stage="downloadingModel", progress=progress, message=message
        ),
    )
    emit("progress", stage="verifying", progress=1.0, message="校验官方 Demucs 模型 SHA-256")
    emit("result", modelReady=True, modelRepository=str(target), model=MODEL_NAME)


def make_separator(model_root: Path, device: str, segment: int, callback=None):
    from demucs.api import Separator

    repository = verified_model_repository(model_root)
    return Separator(
        model=MODEL_NAME,
        repo=repository,
        device=device,
        shifts=1,
        overlap=0.25,
        split=True,
        segment=segment,
        jobs=0,
        progress=False,
        callback=callback,
        callback_arg={"protocol": PROTOCOL_VERSION},
    )


def command_probe(args: argparse.Namespace) -> None:
    import torch

    model_root = Path(args.model_root).resolve()
    model_ready = False
    try:
        verified_model_repository(model_root)
        model_ready = True
    except RuntimeError:
        pass
    cuda_available = bool(torch.cuda.is_available())
    mps_available = bool(hasattr(torch.backends, "mps") and torch.backends.mps.is_available())
    self_test = {"ran": False, "device": "cpu", "ok": True, "modelInference": False}
    if args.self_test:
        device = "cuda" if cuda_available else "mps" if mps_available else "cpu"
        emit("progress", stage="verifying", progress=0.2, message=f"运行 {device.upper()} 张量自检")
        a = torch.ones((128, 128), device=device)
        b = torch.mm(a, a)
        torch.cuda.synchronize() if device == "cuda" else None
        if float(b[0, 0].cpu()) != 128.0:
            raise RuntimeError("TORCH_SELF_TEST_FAILED")
        model_inference = False
        if model_ready:
            emit("progress", stage="verifying", progress=0.55, message=f"运行 {device.upper()} 短推理自检")
            separator = make_separator(model_root, device, segment=2)
            test_audio = torch.zeros((separator.audio_channels, separator.samplerate), dtype=torch.float32)
            _, test_stems = separator.separate_tensor(test_audio)
            if set(test_stems) != set(STEMS):
                raise RuntimeError("MODEL_SELF_TEST_STEMS_MISMATCH")
            if any(not torch.isfinite(stem).all() for stem in test_stems.values()):
                raise RuntimeError("MODEL_SELF_TEST_NON_FINITE")
            model_inference = True
            if device == "cuda":
                torch.cuda.empty_cache()
        self_test = {"ran": True, "device": device, "ok": True, "modelInference": model_inference}
    emit("result",
        pythonVersion=platform.python_version(),
        torchVersion=torch.__version__,
        cudaVersion=torch.version.cuda,
        cudaAvailable=cuda_available,
        mpsAvailable=mps_available,
        demucsVersion=importlib.metadata.version("demucs"),
        modelReady=model_ready,
        selfTest=self_test,
    )


def command_separate(args: argparse.Namespace) -> None:
    import torch
    from demucs.api import save_audio

    input_path = Path(args.input).resolve()
    output_root = Path(args.output).resolve()
    model_root = Path(args.model_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if not input_path.is_file():
        raise RuntimeError("SOURCE_FILE_MISSING")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    if args.device == "mps" and not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
        raise RuntimeError("MPS_NOT_AVAILABLE")

    last_progress = -1.0

    def callback(info: dict[str, Any]) -> None:
        nonlocal last_progress
        length = max(1, int(info.get("audio_length", 1)))
        offset = max(0, int(info.get("segment_offset", 0)))
        model_index = max(0, int(info.get("model_idx_in_bag", 0)))
        model_count = max(1, int(info.get("models", 1)))
        shift_index = max(0, int(info.get("shift_idx", 0)))
        position = min(1.0, offset / length)
        progress = min(0.99, (model_index + shift_index + position) / model_count)
        if progress - last_progress >= 0.002 or info.get("state") == "end":
            last_progress = progress
            emit("progress", stage="separating", progress=progress, segmentOffset=offset, audioLength=length)

    emit("progress", stage="preparing", progress=0.0, message="加载已验证的本地模型")
    separator = make_separator(model_root, args.device, args.segment, callback)
    emit("progress", stage="separating", progress=0.01, message="开始分轨")
    _, separated = separator.separate_audio_file(input_path)
    if set(separated) != set(STEMS):
        raise RuntimeError(f"UNEXPECTED_STEMS:{sorted(separated)}")

    outputs: dict[str, str] = {}
    for index, stem in enumerate(STEMS):
        destination = output_root / f"{stem}.wav"
        save_audio(
            separated[stem].cpu(),
            str(destination),
            samplerate=separator.samplerate,
            bits_per_sample=24,
            clip="rescale",
        )
        if not destination.is_file() or destination.stat().st_size <= 44:
            raise RuntimeError(f"EMPTY_STEM:{stem}")
        outputs[stem] = str(destination)
        emit("progress", stage="postprocessing", progress=(index + 1) / len(STEMS), message=f"写入 {stem}")
    if args.device == "cuda":
        torch.cuda.empty_cache()
    emit("result", files=outputs, sampleRate=44100, channels=2, device=args.device, segment=args.segment)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="bandbuddy-worker")
    commands = root.add_subparsers(dest="command", required=True)

    probe = commands.add_parser("probe")
    probe.add_argument("--model-root", required=True)
    probe.add_argument("--self-test", action="store_true")

    ensure = commands.add_parser("ensure-model")
    ensure.add_argument("--model-root", required=True)

    separate = commands.add_parser("separate")
    separate.add_argument("--input", required=True)
    separate.add_argument("--output", required=True)
    separate.add_argument("--model-root", required=True)
    separate.add_argument("--device", choices=("cuda", "mps", "cpu"), required=True)
    separate.add_argument("--segment", type=int, choices=range(2, 20), default=7)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "probe":
            command_probe(args)
        elif args.command == "ensure-model":
            command_ensure_model(args)
        elif args.command == "separate":
            command_separate(args)
        return 0
    except KeyboardInterrupt:
        emit("error", code="CANCELLED", message="任务已取消")
        return 130
    except torch_oom_types() as error:
        emit("error", code="CUDA_OOM", message=str(error), traceback=traceback.format_exc(limit=5))
        return 42
    except Exception as error:  # The parent process needs structured, bounded failure data.
        emit("error", code=map_error(error), message=str(error), traceback=traceback.format_exc(limit=8))
        return 1


def torch_oom_types() -> tuple[type[BaseException], ...]:
    try:
        import torch
        return (torch.cuda.OutOfMemoryError,)
    except (ImportError, AttributeError):
        return ()


def map_error(error: Exception) -> str:
    text = str(error).upper()
    if "CUDA_NOT_AVAILABLE" in text:
        return "CUDA_NOT_AVAILABLE"
    if "MPS_NOT_AVAILABLE" in text:
        return "MPS_NOT_AVAILABLE"
    if "MODEL_HASH" in text:
        return "MODEL_HASH_MISMATCH"
    if "CUDA" in text and "MEMORY" in text:
        return "CUDA_OOM"
    if "NO SPACE" in text or getattr(error, "errno", None) == 28:
        return "DISK_FULL"
    if "FFMPEG" in text or "LOADAUDIO" in type(error).__name__.upper():
        return "AUDIO_DECODE_FAILED"
    return "WORKER_FAILED"


if __name__ == "__main__":
    raise SystemExit(main())
