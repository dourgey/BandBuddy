"""Deterministic release-only CPU waveform comparison; never used to relax runtime quality."""
from __future__ import annotations

import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import random
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = ROOT / "python/runtime/cpu-comparison-policy.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def policy() -> dict:
    return json.loads(POLICY_PATH.read_text("utf-8"))


def policy_hash() -> str:
    return sha256(POLICY_PATH.read_bytes())


def fixed_input() -> np.ndarray:
    """Pure integer phases/LCG avoid platform-dependent sin/random library implementations."""
    profile = policy()
    state = profile["seed"]
    values = np.empty((profile["channels"], profile["frames"]), dtype="<f4")

    def triangle(index, period):
        return 1.0 - 4.0 * abs((index % period) / period - 0.5)

    for index in range(profile["frames"]):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        noise = ((state >> 8) / 16777216.0 - 0.5) * 0.008
        envelope = 0.25 + 0.75 * ((index % 22050) / 22050.0)
        transient = max(0, 441 - index % 4410) / 441.0
        left = (0.08 * triangle(index, 201) + 0.035 * triangle(index, 101) + 0.015 * triangle(index, 67)) * envelope + noise + 0.02 * transient
        right = (0.075 * triangle(index + 17, 201) + 0.04 * triangle(index + 7, 101) + 0.012 * triangle(index, 89)) * envelope - noise + 0.015 * transient
        values[:, index] = (left, right)
    return values


def model_manifest() -> dict:
    from model_download import BUNDLE_FILES
    from guitar_separator_hq.specs import MODEL_SPECS
    return {
        "models": {item.key: {"filename": item.filename, "bytes": item.size, "sha256": item.sha256} for item in BUNDLE_FILES},
        "configs": {item.key: {"filename": item.config_filename, "sha256": item.config_sha256} for item in MODEL_SPECS},
    }


def production_hash() -> str:
    paths = [ROOT / "python/worker/worker.py", ROOT / "python/worker/model_download.py"]
    source_root = ROOT / "python/guitar_separator_hq"
    paths += [item for item in source_root.rglob("*.py") if "tests" not in item.relative_to(source_root).parts]
    entries = {item.relative_to(ROOT).as_posix(): sha256(item.read_bytes()) for item in sorted(paths)}
    return sha256(canonical(entries))


def environment() -> dict:
    packages = ("torch", "torchaudio", "demucs", "onnxruntime", "numpy", "librosa", "soundfile", "sphn")
    return {"device": "cpu", "platform": platform.system(), "architecture": platform.machine(), "osVersion": platform.release(),
            "python": platform.python_version(), "packages": {name: importlib.metadata.version(name) for name in packages}}


def seed_cpu() -> None:
    import torch
    seed = policy()["seed"]
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    torch.set_float32_matmul_precision("highest")


def infer(model_root: Path) -> dict[str, np.ndarray]:
    import torch
    from model_download import verify_bundle
    from worker import make_separator, emit, SIX_STEMS, test_onnx_cpu
    from guitar_separator_hq.separator import separate_guitar_arrays, validate_audio_array
    from guitar_separator_hq.specs import model_specs_for_quality
    profile = policy()
    torch.set_num_threads(profile["cpuThreads"])
    torch.set_num_interop_threads(1)
    test_onnx_cpu()
    repository = verify_bundle(model_root, full=True)
    source = fixed_input()
    output = {}
    seed_cpu()
    emit("progress", stage="reference", message="CPU 数值验收：六轨")
    separator = make_separator(model_root, "cpu", repository=repository)
    stems = separator.separate_tensor(torch.from_numpy(source.copy()), sr=profile["sampleRate"])[1]
    if set(stems) != set(SIX_STEMS):
        raise RuntimeError("CPU_COMPARISON_SIX_STEMS_MISMATCH")
    for name in SIX_STEMS:
        output[f"six_stem/{name}"] = validate_audio_array(stems[name].detach().cpu().numpy(), name=name, frames=profile["frames"])
    del separator, stems
    for quality in ("fast", "balanced", "high"):
        seed_cpu()
        emit("progress", stage="reference", message=f"CPU 数值验收：{quality}")
        weights = {spec.key: repository / spec.filename for spec in model_specs_for_quality(quality)}
        guitar = separate_guitar_arrays(source.copy(), repository, device_name="cpu", download_missing=False, quality=quality, weights=weights)
        for name in ("acoustic_guitar", "lead_guitar", "rhythm_guitar"):
            output[f"{quality}/{name}"] = validate_audio_array(getattr(guitar, name), name=name, frames=profile["frames"])
        del guitar
    return output


def array_bytes(value: np.ndarray) -> bytes:
    data = io.BytesIO()
    np.save(data, np.ascontiguousarray(value, dtype="<f4"), allow_pickle=False)
    return data.getvalue()


def export_reference(destination: Path, output: dict[str, np.ndarray]) -> dict:
    if destination.exists():
        raise RuntimeError("CPU_REFERENCE_EXISTS: use a new reviewable destination; references are immutable")
    profile = policy()
    baseline_environment = environment()
    if any(baseline_environment["packages"].get(name) != version for name, version in profile["referencePackages"].items()):
        raise RuntimeError("CPU_REFERENCE_BASELINE_RUNTIME_MISMATCH")
    if set(output) != set(profile["tracks"]):
        raise RuntimeError("CPU_REFERENCE_TRACKS_INCOMPLETE")
    arrays = {"input.npy": array_bytes(fixed_input())}
    for name in profile["tracks"]:
        value = output[name]
        if value.shape != (profile["channels"], profile["frames"]) or not np.isfinite(value).all():
            raise RuntimeError(f"CPU_REFERENCE_OUTPUT_INVALID:{name}")
        arrays[f"{name}.npy"] = array_bytes(value)
    metadata = {"schema": 1, "protocol": profile["protocol"], "policySha256": policy_hash(), "inputSha256": sha256(fixed_input().tobytes()),
                "seed": profile["seed"], "cpuThreads": profile["cpuThreads"], "deterministicAlgorithms": True,
                "models": model_manifest(), "modelManifestSha256": sha256(canonical(model_manifest())), "productionCodeSha256": production_hash(),
                "environment": baseline_environment, "tracks": profile["tracks"], "files": {name: sha256(value) for name, value in arrays.items()}}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, value in sorted({**arrays, "manifest.json": canonical(metadata)}.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value)
    return {"schema": 1, "protocol": profile["protocol"], "sha256": sha256(destination.read_bytes()),
            "policySha256": metadata["policySha256"], "inputSha256": metadata["inputSha256"],
            "modelManifestSha256": metadata["modelManifestSha256"], "productionCodeSha256": metadata["productionCodeSha256"],
            "referenceEnvironment": metadata["environment"]}


def read_reference(source: Path, pin: dict) -> tuple[dict, dict[str, np.ndarray]]:
    if pin.get("schema") != 1 or pin.get("protocol") != policy()["protocol"] or pin.get("policySha256") != policy_hash():
        raise RuntimeError("CPU_REFERENCE_PIN_INVALID")
    if not source.is_file() or sha256(source.read_bytes()) != pin.get("sha256"):
        raise RuntimeError("CPU_REFERENCE_SHA256_MISMATCH")
    expected_files = {"manifest.json", "input.npy", *[f"{name}.npy" for name in policy()["tracks"]]}
    with zipfile.ZipFile(source) as archive:
        if set(archive.namelist()) != expected_files or len(archive.namelist()) != len(expected_files) or any(item.file_size > 2_000_000 for item in archive.infolist()):
            raise RuntimeError("CPU_REFERENCE_ARCHIVE_INVALID")
        metadata = json.loads(archive.read("manifest.json"))
        for key, expected in {"schema": 1, "protocol": policy()["protocol"], "policySha256": policy_hash(), "inputSha256": sha256(fixed_input().tobytes()),
                              "modelManifestSha256": sha256(canonical(model_manifest())), "productionCodeSha256": production_hash()}.items():
            if metadata.get(key) != expected or (key not in ("schema", "protocol") and pin.get(key) != expected):
                raise RuntimeError(f"CPU_REFERENCE_PROFILE_MISMATCH:{key}")
        if metadata.get("tracks") != policy()["tracks"] or metadata.get("models") != model_manifest() or metadata.get("environment") != pin.get("referenceEnvironment"):
            raise RuntimeError("CPU_REFERENCE_MANIFEST_MISMATCH")
        if metadata.get("seed") != policy()["seed"] or metadata.get("cpuThreads") != policy()["cpuThreads"] or metadata.get("deterministicAlgorithms") is not True:
            raise RuntimeError("CPU_REFERENCE_DETERMINISM_MISMATCH")
        if metadata.get("environment", {}).get("device") != "cpu" or any(metadata["environment"]["packages"].get(name) != version for name, version in policy()["referencePackages"].items()):
            raise RuntimeError("CPU_REFERENCE_BASELINE_RUNTIME_MISMATCH")
        arrays = {}
        for filename in expected_files - {"manifest.json"}:
            data = archive.read(filename)
            if sha256(data) != metadata.get("files", {}).get(filename):
                raise RuntimeError(f"CPU_REFERENCE_FILE_HASH_MISMATCH:{filename}")
            value = np.load(io.BytesIO(data), allow_pickle=False)
            if value.dtype != np.dtype("<f4") or value.shape != (policy()["channels"], policy()["frames"]) or not np.isfinite(value).all():
                raise RuntimeError(f"CPU_REFERENCE_ARRAY_INVALID:{filename}")
            arrays[filename.removesuffix(".npy")] = value
        if not np.array_equal(arrays.pop("input"), fixed_input()):
            raise RuntimeError("CPU_REFERENCE_INPUT_MISMATCH")
    return metadata, arrays


def compare_outputs(reference: dict[str, np.ndarray], actual: dict[str, np.ndarray]) -> dict:
    profile = policy()
    if set(reference) != set(profile["tracks"]) or set(actual) != set(profile["tracks"]):
        raise RuntimeError("CPU_COMPARISON_TRACKS_INCOMPLETE")
    report = {}
    for name in profile["tracks"]:
        target, baseline = actual[name], reference[name]
        if target.shape != baseline.shape or target.dtype != np.float32 or not np.isfinite(target).all():
            raise RuntimeError(f"CPU_COMPARISON_OUTPUT_INVALID:{name}")
        error = target.astype(np.float64) - baseline.astype(np.float64)
        rmse = float(np.sqrt(np.mean(np.square(error))))
        metrics = {"maxAbs": float(np.abs(error).max()), "rmse": rmse,
                   "relativeL2": rmse / max(profile["relativeRmsFloor"], float(np.sqrt(np.mean(np.square(baseline.astype(np.float64))))))}
        report[name] = {**metrics, "passed": all(metrics[key] <= limit for key, limit in profile["thresholds"].items()),
                        "referencePcmSha256": sha256(np.ascontiguousarray(baseline, dtype="<f4").tobytes()),
                        "actualPcmSha256": sha256(np.ascontiguousarray(target, dtype="<f4").tobytes())}
    return {"schema": 1, "protocol": profile["protocol"], "passed": all(value["passed"] for value in report.values()),
            "policySha256": policy_hash(), "thresholds": profile["thresholds"], "tracks": report}
