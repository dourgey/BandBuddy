#!/usr/bin/env python3
"""BandBuddy's finite, JSON-lines staged stem-separation worker."""

from __future__ import annotations

import argparse
import base64
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import sys
import traceback
import time
from typing import Any


PROTOCOL_VERSION = 2
DEMUCS_MODEL_NAME = "htdemucs_6s"
DEMUCS_SEGMENT_SECONDS = 7
SIX_STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")
GUITAR_STEMS = ("acoustic_guitar", "lead_guitar", "rhythm_guitar")
STEMS = (
    "vocals",
    "drums",
    "bass",
    "guitar",
    "acoustic_guitar",
    "lead_guitar",
    "rhythm_guitar",
    "piano",
    "other",
)

# Development keeps the package next to worker/. Packaged builds copy it below
# worker/. Supporting both layouts avoids environment-specific import behavior.
WORKER_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = WORKER_ROOT.parent
if (SOURCE_ROOT.joinpath("guitar_separator_hq").is_dir()):
    sys.path.insert(0, str(SOURCE_ROOT))


def emit(kind: str, **payload: Any) -> None:
    print(
        json.dumps({"protocol": PROTOCOL_VERSION, "type": kind, **payload}, ensure_ascii=False),
        flush=True,
    )


def verified_bundle(model_root: Path, required_keys: tuple[str, ...] | None = None) -> Path:
    from model_download import verify_bundle

    return verify_bundle(model_root, required_keys)


def command_ensure_model(args: argparse.Namespace) -> None:
    from model_download import install_bundle

    target = install_bundle(
        Path(args.model_root).resolve(),
        progress=lambda progress, message: emit(
            "progress", stage="downloadingModel", progress=progress, message=message
        ),
    )
    emit("progress", stage="verifying", progress=1.0, message="分轨资源校验完成")
    emit("result", modelReady=True, modelRepository=str(target))


def make_separator(
    model_root: Path,
    device: str,
    callback=None,
    repository: Path | None = None,
):
    from demucs.api import Separator

    repository = repository or verified_bundle(model_root, ("six_stem",))
    return Separator(
        model=DEMUCS_MODEL_NAME,
        repo=repository,
        device=device,
        shifts=1,
        overlap=0.25,
        split=True,
        segment=DEMUCS_SEGMENT_SECONDS,
        jobs=0,
        progress=False,
        callback=callback,
        callback_arg={"protocol": PROTOCOL_VERSION},
    )


def test_onnx_cpu() -> None:
    """Execute an ONNX Identity graph, without requiring the ONNX compiler package."""
    import numpy as np
    import onnxruntime as ort
    # IR 8/opset 13, float32[2] Identity. Compatible with both Intel and current ORT.
    model = base64.b64decode("CAg6SgoQCgF4EgF5IghJZGVudGl0eRIUYmFuZGJ1ZGR5X2NwdV9oZWFsdGhaDwoBeBIKCggIARIECgIIAmIPCgF5EgoKCAgBEgQKAggCQgIQDQ==")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(model, sess_options=options, providers=["CPUExecutionProvider"])
    source = np.array([0.25, -0.5], dtype=np.float32)
    result = session.run(None, {"x": source})[0]
    if not np.array_equal(source, result):
        raise RuntimeError("ONNXRUNTIME_CPU_SELF_TEST_FAILED")


def test_guitar_qualities(repository: Path, device: str) -> list[str]:
    """Release qualification runs all production policies, without reducing quality."""
    import numpy as np
    from guitar_separator_hq.separator import SAMPLE_RATE, separate_guitar_arrays, validate_audio_array
    from guitar_separator_hq.specs import model_specs_for_quality
    seconds = np.arange(SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
    wave = (0.02 * np.sin(2 * np.pi * 220 * seconds) + 0.01 * np.sin(2 * np.pi * 443 * seconds)).astype(np.float32)
    source = np.stack([wave, wave * 0.8])
    completed = []
    for quality in ("fast", "balanced", "high"):
        emit("progress", stage="verifying", progress=0.6 + len(completed) * 0.1, message=f"正在验证 {quality} 完整分轨链路")
        weights = {spec.key: repository / spec.filename for spec in model_specs_for_quality(quality)}
        result = separate_guitar_arrays(source, repository, device_name=device, download_missing=False, quality=quality, weights=weights)
        for name in ("acoustic_guitar", "lead_guitar", "rhythm_guitar"):
            validate_audio_array(getattr(result, name), name=name, frames=SAMPLE_RATE)
        completed.append(quality)
    return completed


def command_probe(args: argparse.Namespace) -> None:
    from model_download import verify_bundle
    cache = Path(sys.prefix) / "bandbuddy-health.json"
    packages = ("torch", "torchaudio", "demucs", "onnxruntime", "numpy", "librosa", "soundfile", "sphn")
    versions = {}
    for name in packages:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    full_self_test = getattr(args, "full_self_test", False)
    if args.quick and not args.self_test and not full_self_test:
        try:
            cached = json.loads(cache.read_text("utf-8"))
            if cached.get("schema") == 1 and cached.get("versions") == versions and 0 <= time.time() - cached.get("checkedAt", 0) < 86400:
                verify_bundle(Path(args.model_root), full=False)
                emit("result", **cached["result"])
                return
        except (OSError, ValueError, RuntimeError, TypeError, KeyError):
            pass
    import torch
    torch.set_num_threads(max(1, int(os.environ.get("BANDBUDDY_CPU_THREADS", "2"))))
    torch.set_num_interop_threads(1)

    try:
        import onnxruntime as ort

        onnxruntime_version: str | None = ort.__version__
        onnxruntime_providers: list[str] = ort.get_available_providers()
    except (ImportError, OSError):
        onnxruntime_version = None
        onnxruntime_providers = []
    dependency_errors = []
    for name in ("demucs.api", "sphn", "librosa", "soundfile", "torchaudio"):
        try:
            __import__(name)
        except (ImportError, OSError) as error:
            dependency_errors.append(f"{name}: {error}")
    dependencies_ready = not dependency_errors and onnxruntime_version is not None and "CPUExecutionProvider" in onnxruntime_providers

    model_root = Path(args.model_root).resolve()
    model_ready = False
    repository = None
    try:
        repository = verify_bundle(model_root, full=not args.quick)
        model_ready = True
    except RuntimeError:
        pass
    cuda_available = bool(torch.cuda.is_available())
    mps_available = bool(platform.machine() not in ("x86_64", "AMD64") and hasattr(torch.backends, "mps") and torch.backends.mps.is_available())
    self_test = {"ran": False, "device": "cpu", "ok": True, "modelInference": False}
    if args.self_test or full_self_test:
        if not dependencies_ready or not model_ready:
            raise RuntimeError(f"RUNTIME_DEPENDENCIES_INCOMPLETE:{dependency_errors}")
        requested = getattr(args, "device", "auto")
        device = "cpu" if requested == "cpu" else "cuda" if cuda_available and requested in ("auto", "cuda") else "mps" if mps_available else "cpu"
        emit("progress", stage="verifying", progress=0.2, message="正在检查分轨环境")
        test_onnx_cpu()
        try:
            a = torch.ones((128, 128), device=device)
            b = torch.mm(a, a)
            if device == "cuda":
                torch.cuda.synchronize()
        except RuntimeError:
            if device == "cpu":
                raise
            if device == "cuda": cuda_available = False
            if device == "mps": mps_available = False
            device = "cpu"
            a = torch.ones((128, 128))
            b = torch.mm(a, a)
        if float(b[0, 0].cpu()) != 128.0:
            raise RuntimeError("TORCH_SELF_TEST_FAILED")
        model_inference = False
        if model_ready:
            emit("progress", stage="verifying", progress=0.55, message="正在运行短推理检查")
            def test_separator(selected):
                separator = make_separator(model_root, selected, repository=repository)
                test_audio = torch.zeros((separator.audio_channels, separator.samplerate), dtype=torch.float32)
                return separator.separate_tensor(test_audio, sr=separator.samplerate)[1]
            try:
                test_stems = test_separator(device)
            except (RuntimeError, NotImplementedError):
                if device == "cpu":
                    raise
                if device == "cuda": cuda_available = False
                if device == "mps": mps_available = False
                device = "cpu"
                emit("progress", stage="verifying", progress=0.55, message="加速设备自检未通过，正在检查 CPU 环境")
                test_stems = test_separator(device)
            if set(test_stems) != set(SIX_STEMS):
                raise RuntimeError("MODEL_SELF_TEST_STEMS_MISMATCH")
            if any(not torch.isfinite(stem).all() for stem in test_stems.values()):
                raise RuntimeError("MODEL_SELF_TEST_NON_FINITE")
            model_inference = True
            if device == "cuda":
                torch.cuda.empty_cache()
        self_test = {
            "ran": True,
            "device": device,
            "ok": True,
            "modelInference": model_inference,
            "onnxCpuInference": True,
            "guitarQualities": test_guitar_qualities(repository, device) if full_self_test else [],
        }
    result = dict(
        pythonVersion=platform.python_version(),
        torchVersion=torch.__version__,
        cudaVersion=torch.version.cuda,
        cudaAvailable=cuda_available,
        mpsAvailable=mps_available,
        demucsVersion=importlib.metadata.version("demucs"),
        onnxRuntimeVersion=onnxruntime_version,
        onnxRuntimeProviders=onnxruntime_providers,
        modelReady=model_ready,
        dependenciesReady=dependencies_ready,
        dependencyErrors=dependency_errors,
        selfTest=self_test,
    )
    if dependencies_ready and model_ready:
        try:
            temporary = cache.with_suffix(".part")
            temporary.write_text(json.dumps({"schema": 1, "versions": versions, "checkedAt": time.time(), "result": result}), "utf-8")
            os.replace(temporary, cache)
        except OSError:
            pass  # Read-only old installations can still run normally.
    emit("result", **result)


def command_separate_demucs(args: argparse.Namespace) -> None:
    import numpy as np
    import soundfile as sf
    import torch

    from guitar_separator_hq.separator import (
        SAMPLE_RATE,
        audio_stats,
        load_audio,
        validate_audio_array,
        write_float_wav,
    )

    input_path = Path(args.input).resolve()
    output_root = Path(args.output).resolve()
    model_root = Path(args.model_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if not input_path.is_file():
        raise RuntimeError("SOURCE_FILE_MISSING")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    if args.device == "mps" and not (
        hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    ):
        raise RuntimeError("MPS_NOT_AVAILABLE")

    emit("progress", stage="preparing", progress=0.0, message="正在解码")
    mix = load_audio(input_path)
    expected_frames = mix.shape[-1]
    outputs: dict[str, str] = {}
    statistics: dict[str, dict[str, float]] = {}
    last_progress = -1.0

    def demucs_callback(info: dict[str, Any]) -> None:
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
            emit("progress", stage="separating", progress=progress, message="正在生成基础分轨")

    separator = make_separator(model_root, args.device, demucs_callback)
    emit("progress", stage="separating", progress=0.01, message="正在生成基础分轨")
    _, separated = separator.separate_tensor(torch.from_numpy(mix), sr=SAMPLE_RATE)
    if set(separated) != set(SIX_STEMS):
        raise RuntimeError(f"UNEXPECTED_STEMS:{sorted(separated)}")
    for stem in SIX_STEMS:
        audio = separated[stem].detach().float().cpu().numpy()
        audio = validate_audio_array(audio, name=stem, frames=expected_frames)
        destination = output_root / f"{stem}.wav"
        write_float_wav(destination, audio)
        outputs[stem] = str(destination)
        statistics[stem] = audio_stats(audio)
        info = sf.info(destination)
        if info.frames != expected_frames or info.channels != 2 or info.samplerate != SAMPLE_RATE:
            raise RuntimeError(f"WRITTEN_STEM_FORMAT_INVALID:{stem}")
        if not np.isfinite(statistics[stem]["peak"]):
            raise RuntimeError(f"WRITTEN_STEM_PEAK_INVALID:{stem}")
    del separated, separator
    if args.device == "cuda":
        torch.cuda.empty_cache()
    emit("progress", stage="postprocessing", progress=1.0, message="基础分轨完成")
    emit(
        "result",
        files=outputs,
        stats=statistics,
        sampleRate=SAMPLE_RATE,
        channels=2,
        frames=expected_frames,
        device=args.device,
    )


def command_separate_guitar(args: argparse.Namespace) -> None:
    import numpy as np
    import soundfile as sf
    import torch

    from guitar_separator_hq.separator import (
        SAMPLE_RATE,
        audio_stats,
        load_audio,
        separate_guitar_arrays,
        validate_audio_array,
        write_float_wav,
    )
    from guitar_separator_hq.specs import model_specs_for_quality, normalize_quality

    input_path = Path(args.input).resolve()
    output_root = Path(args.output).resolve()
    model_root = Path(args.model_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if not input_path.is_file():
        raise RuntimeError("SOURCE_FILE_MISSING")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    if args.device == "mps" and not (
        hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    ):
        raise RuntimeError("MPS_NOT_AVAILABLE")

    quality = normalize_quality(args.quality)
    required_bundle_keys = (
        ("acoustic_guitar_fast", "electric_guitar_fast", "lead_rhythm_fast")
        if quality == "fast"
        else ("shared_acoustic_electric", "lead_rhythm_hq")
    )
    bundle = verified_bundle(model_root, required_bundle_keys)
    emit("progress", stage="preparing", progress=0.0, message="正在解码")
    mix = load_audio(input_path)
    expected_frames = mix.shape[-1]
    stage_ranges = (
        {
            "acoustic_fast": (0.0, 0.33),
            "electric_fast": (0.33, 0.34),
            "lead_fast": (0.67, 0.32),
        }
        if quality == "fast"
        else {"shared_bs": (0.0, 0.66), "lead_hq": (0.66, 0.33)}
    )

    def guitar_progress(stage: str, fraction: float, message: str) -> None:
        start, span = stage_ranges.get(stage, (0.0, 0.0))
        emit(
            "progress",
            stage="separating",
            progress=min(0.99, start + span * fraction),
            message="正在极速细分吉他轨（预览质量）" if quality == "fast" else "正在细分吉他轨",
        )

    weights = {
        spec.key: bundle / spec.filename for spec in model_specs_for_quality(quality)
    }
    guitar = separate_guitar_arrays(
        mix,
        bundle,
        device_name=args.device,
        download_missing=False,
        weights=weights,
        progress=guitar_progress,
        quality=quality,
    )
    if guitar.reconstruction["peak"] > 1e-6:
        raise RuntimeError(
            f"LEAD_RHYTHM_RECONSTRUCTION_FAILED:{guitar.reconstruction['peak']:.9g}"
        )
    outputs: dict[str, str] = {}
    statistics: dict[str, dict[str, float]] = {}
    for stem in GUITAR_STEMS:
        audio = validate_audio_array(guitar.stems[stem], name=stem, frames=expected_frames)
        destination = output_root / f"{stem}.wav"
        write_float_wav(destination, audio)
        outputs[stem] = str(destination)
        statistics[stem] = audio_stats(audio)
        info = sf.info(destination)
        if info.frames != expected_frames or info.channels != 2 or info.samplerate != SAMPLE_RATE:
            raise RuntimeError(f"WRITTEN_STEM_FORMAT_INVALID:{stem}")
        if not np.isfinite(statistics[stem]["peak"]):
            raise RuntimeError(f"WRITTEN_STEM_PEAK_INVALID:{stem}")
    if args.device == "cuda":
        torch.cuda.empty_cache()
    emit("progress", stage="postprocessing", progress=1.0, message="吉他细分完成")
    emit(
        "result",
        files=outputs,
        stats=statistics,
        sampleRate=SAMPLE_RATE,
        channels=2,
        frames=expected_frames,
        device=args.device,
        reconstruction=guitar.reconstruction,
        quality=quality,
        previewQuality=quality == "fast",
        inference=guitar.reports,
    )


def command_separate(args: argparse.Namespace) -> None:
    import numpy as np
    import torch

    from guitar_separator_hq.separator import (
        SAMPLE_RATE,
        audio_stats,
        load_audio,
        separate_guitar_arrays,
        validate_audio_array,
        write_float_wav,
    )
    from guitar_separator_hq.specs import model_specs_for_quality, normalize_quality

    input_path = Path(args.input).resolve()
    output_root = Path(args.output).resolve()
    model_root = Path(args.model_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if not input_path.is_file():
        raise RuntimeError("SOURCE_FILE_MISSING")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    if args.device == "mps" and not (
        hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    ):
        raise RuntimeError("MPS_NOT_AVAILABLE")

    quality = normalize_quality(args.quality)
    bundle = verified_bundle(model_root)
    emit("progress", stage="preparing", progress=0.0, message="正在解码")
    mix = load_audio(input_path)
    expected_frames = mix.shape[-1]
    outputs: dict[str, str] = {}
    statistics: dict[str, dict[str, float]] = {}

    last_progress = -1.0

    def demucs_callback(info: dict[str, Any]) -> None:
        nonlocal last_progress
        length = max(1, int(info.get("audio_length", 1)))
        offset = max(0, int(info.get("segment_offset", 0)))
        model_index = max(0, int(info.get("model_idx_in_bag", 0)))
        model_count = max(1, int(info.get("models", 1)))
        shift_index = max(0, int(info.get("shift_idx", 0)))
        position = min(1.0, offset / length)
        local_progress = min(0.99, (model_index + shift_index + position) / model_count)
        overall = 0.24 * local_progress
        if overall - last_progress >= 0.002 or info.get("state") == "end":
            last_progress = overall
            emit("progress", stage="separating", progress=overall, message="正在分轨")

    separator = make_separator(model_root, args.device, demucs_callback, repository=bundle)
    emit("progress", stage="separating", progress=0.01, message="正在分轨")
    _, separated = separator.separate_tensor(torch.from_numpy(mix), sr=SAMPLE_RATE)
    if set(separated) != set(SIX_STEMS):
        raise RuntimeError(f"UNEXPECTED_STEMS:{sorted(separated)}")
    for stem in SIX_STEMS:
        audio = separated[stem].detach().float().cpu().numpy()
        audio = validate_audio_array(audio, name=stem, frames=expected_frames)
        destination = output_root / f"{stem}.wav"
        write_float_wav(destination, audio)
        outputs[stem] = str(destination)
        statistics[stem] = audio_stats(audio)
    del separated, separator
    if args.device == "cuda":
        torch.cuda.empty_cache()

    stage_ranges = (
        {
            "acoustic_fast": (0.24, 0.25),
            "electric_fast": (0.49, 0.25),
            "lead_fast": (0.74, 0.25),
        }
        if quality == "fast"
        else {"shared_bs": (0.24, 0.5), "lead_hq": (0.74, 0.25)}
    )

    def guitar_progress(stage: str, fraction: float, message: str) -> None:
        start, span = stage_ranges.get(stage, (0.24, 0.0))
        emit(
            "progress",
            stage="separating",
            progress=min(0.99, start + span * fraction),
            message="正在分轨",
        )

    weights = {
        spec.key: bundle / spec.filename for spec in model_specs_for_quality(quality)
    }
    guitar = separate_guitar_arrays(
        mix,
        bundle,
        device_name=args.device,
        download_missing=False,
        weights=weights,
        progress=guitar_progress,
        quality=quality,
    )
    if guitar.reconstruction["peak"] > 1e-6:
        raise RuntimeError(
            f"LEAD_RHYTHM_RECONSTRUCTION_FAILED:{guitar.reconstruction['peak']:.9g}"
        )
    for stem, audio in guitar.stems.items():
        audio = validate_audio_array(audio, name=stem, frames=expected_frames)
        destination = output_root / f"{stem}.wav"
        write_float_wav(destination, audio)
        outputs[stem] = str(destination)
        statistics[stem] = audio_stats(audio)

    if set(outputs) != set(STEMS):
        raise RuntimeError(f"INCOMPLETE_STEMS:{sorted(outputs)}")
    for stem in STEMS:
        destination = Path(outputs[stem])
        import soundfile as sf

        info = sf.info(destination)
        if info.frames != expected_frames or info.channels != 2 or info.samplerate != SAMPLE_RATE:
            raise RuntimeError(f"WRITTEN_STEM_FORMAT_INVALID:{stem}")
        if not np.isfinite(statistics[stem]["peak"]):
            raise RuntimeError(f"WRITTEN_STEM_PEAK_INVALID:{stem}")

    if args.device == "cuda":
        torch.cuda.empty_cache()
    emit("progress", stage="postprocessing", progress=1.0, message="分轨完成")
    emit(
        "result",
        files=outputs,
        stats=statistics,
        sampleRate=SAMPLE_RATE,
        channels=2,
        frames=expected_frames,
        device=args.device,
        reconstruction=guitar.reconstruction,
        quality=quality,
        previewQuality=quality == "fast",
        inference=guitar.reports,
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="bandbuddy-worker")
    commands = root.add_subparsers(dest="command", required=True)

    probe = commands.add_parser("probe")
    probe.add_argument("--model-root", required=True)
    probe.add_argument("--self-test", action="store_true")
    probe.add_argument("--full-self-test", action="store_true", help="Release validation: six stems, CPU ONNX, and all three production guitar policies.")
    probe.add_argument("--quick", action="store_true")
    probe.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")

    ensure = commands.add_parser("ensure-model")
    ensure.add_argument("--model-root", required=True)

    for name in ("separate", "separate-demucs", "separate-guitar"):
        separate = commands.add_parser(name)
        separate.add_argument("--input", required=True)
        separate.add_argument("--output", required=True)
        separate.add_argument("--model-root", required=True)
        separate.add_argument("--device", choices=("cuda", "mps", "cpu"), required=True)
        separate.add_argument(
            "--quality",
            choices=("fast", "balanced", "high"),
            default="high",
            help="Guitar split policy; old queued commands retain the v2.0 HQ6 default.",
        )
    return root


def main() -> int:
    args = parser().parse_args()
    if hasattr(args, "output"):
        os.environ["BANDBUDDY_MEMORY_DIR"] = str(Path(args.output).resolve() / ".scratch")
    try:
        if args.command not in ("ensure-model", "probe"):
            import torch
            torch.set_num_threads(max(1, int(os.environ.get("BANDBUDDY_CPU_THREADS", "2"))))
            torch.set_num_interop_threads(1)
        if args.command == "probe":
            command_probe(args)
        elif args.command == "ensure-model":
            command_ensure_model(args)
        elif args.command == "separate":
            command_separate(args)
        elif args.command == "separate-demucs":
            command_separate_demucs(args)
        elif args.command == "separate-guitar":
            command_separate_guitar(args)
        return 0
    except KeyboardInterrupt:
        emit("error", code="CANCELLED", message="任务已取消")
        return 130
    except torch_oom_types() as error:
        emit(
            "error",
            code="ACCELERATOR_OOM",
            message=str(error),
            traceback=traceback.format_exc(limit=5),
        )
        return 42
    except Exception as error:
        emit(
            "error",
            code=map_error(error),
            message=str(error),
            traceback=traceback.format_exc(limit=8),
        )
        return 1


def torch_oom_types() -> tuple[type[BaseException], ...]:
    try:
        import torch

        return (torch.cuda.OutOfMemoryError,)
    except (ImportError, AttributeError, OSError):
        return ()


def map_error(error: Exception) -> str:
    text = str(error).upper()
    if "CUDA_NOT_AVAILABLE" in text:
        return "CUDA_NOT_AVAILABLE"
    if "MPS_NOT_AVAILABLE" in text:
        return "MPS_NOT_AVAILABLE"
    if "OUT OF MEMORY" in text or ("CUDA" in text and "MEMORY" in text):
        return "ACCELERATOR_OOM"
    if "MODEL_HASH" in text or "MODEL_SIZE" in text:
        return "MODEL_HASH_MISMATCH"
    if "NO SPACE" in text or getattr(error, "errno", None) == 28:
        return "DISK_FULL"
    if "FFMPEG" in text or "LOADAUDIO" in type(error).__name__.upper():
        return "AUDIO_DECODE_FAILED"
    return "WORKER_FAILED"


if __name__ == "__main__":
    raise SystemExit(main())
