#!/usr/bin/env python3
"""Download official Demucs v4 model files without Hugging Face.

The file names and bag definitions below are pinned to facebookresearch/demucs:
https://github.com/facebookresearch/demucs/tree/main/demucs/remote
The weights themselves are served from the official URL used by Demucs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import ssl
import sys
import time
from typing import Callable, NamedTuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


OFFICIAL_MODEL_ROOT = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/"
DEFAULT_MODEL_ROOT = Path.cwd() / "models"
CHUNK_SIZE = 1024 * 1024


class ModelSpec(NamedTuple):
    bag: str
    files: tuple[str, ...]


MODEL_SPECS: dict[str, ModelSpec] = {
    "htdemucs_ft": ModelSpec(
        bag=(
            "models: ['f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d']\n"
            "weights:\n"
            "  - [1., 0., 0., 0.]\n"
            "  - [0., 1., 0., 0.]\n"
            "  - [0., 0., 1., 0.]\n"
            "  - [0., 0., 0., 1.]\n"
        ),
        files=(
            "f7e0c4bc-ba3fe64a.th",
            "d12395a8-e57c48e6.th",
            "92cfc3b6-ef3bcb9c.th",
            "04573f0d-f3cf25b2.th",
        ),
    ),
    "htdemucs_6s": ModelSpec(
        bag="models: ['5c90dfd2']\n",
        files=("5c90dfd2-34c22ccb.th",),
    ),
}

ProgressCallback = Callable[[float, str], None]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


def expected_checksum(filename: str) -> str:
    """Return the SHA-256 prefix embedded by Demucs in an official file name."""
    return Path(filename).stem.rsplit("-", 1)[1].lower()


def verify_weight(path: Path) -> str:
    if not path.is_file():
        raise RuntimeError(f"MODEL_FILE_MISSING:{path.name}")
    actual = sha256_file(path)
    expected = expected_checksum(path.name)
    if not actual.startswith(expected):
        raise RuntimeError(
            f"MODEL_HASH_MISMATCH:{path.name}:expected {expected}, got {actual[:len(expected)]}"
        )
    return actual


def repository_path(model_root: Path) -> Path:
    return model_root.resolve() / "demucs-v4"


def marker_path(model_root: Path, model: str) -> Path:
    return repository_path(model_root) / f".{model}.verified.json"


def verify_model(model: str, model_root: Path) -> Path:
    spec = MODEL_SPECS[model]
    target = repository_path(model_root)
    bag_path = target / f"{model}.yaml"
    if not bag_path.is_file() or bag_path.read_text("utf-8") != spec.bag:
        raise RuntimeError(f"MODEL_BAG_MISSING_OR_CHANGED:{model}")
    hashes = {filename: verify_weight(target / filename) for filename in spec.files}
    marker = marker_path(model_root, model)
    if not marker.is_file():
        raise RuntimeError(f"MODEL_MARKER_MISSING:{model}")
    try:
        recorded = json.loads(marker.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"MODEL_MARKER_INVALID:{model}") from error
    if recorded.get("model") != model or recorded.get("files") != hashes:
        raise RuntimeError(f"MODEL_MARKER_MISMATCH:{model}")
    return target


def _content_length(headers: object) -> int | None:
    value = getattr(headers, "get", lambda _key: None)("Content-Length")
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _download_once(url: str, destination: Path, progress: Callable[[float], None]) -> None:
    partial = destination.with_name(destination.name + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "BandBuddy/0.1 Demucs-model-downloader"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = Request(url, headers=headers)
    context = ssl.create_default_context()
    with urlopen(request, timeout=60, context=context) as response:
        status = getattr(response, "status", response.getcode())
        resumed = offset > 0 and status == 206
        if not resumed:
            offset = 0
        length = _content_length(response.headers)
        total = offset + length if length is not None else None
        mode = "ab" if resumed else "wb"
        downloaded = offset
        with partial.open(mode) as handle:
            while True:
                block = response.read(CHUNK_SIZE)
                if not block:
                    break
                handle.write(block)
                downloaded += len(block)
                if total:
                    progress(min(0.99, downloaded / total))
            handle.flush()
            os.fsync(handle.fileno())
    if total is not None and downloaded != total:
        raise OSError(f"INCOMPLETE_DOWNLOAD:{destination.name}:{downloaded}/{total}")
    _verify_as(partial, destination.name)
    os.replace(partial, destination)
    progress(1.0)


def _verify_as(path: Path, official_name: str) -> Path:
    """Verify a .part file against the checksum carried by its final name."""
    actual = sha256_file(path)
    expected = expected_checksum(official_name)
    if not actual.startswith(expected):
        raise RuntimeError(
            f"MODEL_HASH_MISMATCH:{official_name}:expected {expected}, got {actual[:len(expected)]}"
        )
    return path


def download_file(
    url: str,
    destination: Path,
    retries: int,
    progress: Callable[[float], None],
) -> None:
    if destination.is_file():
        try:
            verify_weight(destination)
            progress(1.0)
            return
        except RuntimeError:
            destination.unlink()
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            _download_once(url, destination, progress)
            return
        except (HTTPError, URLError, TimeoutError, OSError, ssl.SSLError, RuntimeError) as error:
            last_error = error
            if attempt == retries:
                break
            if isinstance(error, RuntimeError) and "MODEL_HASH_MISMATCH" in str(error):
                destination.with_name(destination.name + ".part").unlink(missing_ok=True)
            if isinstance(error, HTTPError) and error.code == 416:
                destination.with_name(destination.name + ".part").unlink(missing_ok=True)
            time.sleep(min(8.0, 0.75 * (2**attempt)))
    raise RuntimeError(f"MODEL_DOWNLOAD_FAILED:{destination.name}:{last_error}") from last_error


def download_model(
    model: str,
    model_root: Path,
    *,
    base_url: str = OFFICIAL_MODEL_ROOT,
    retries: int = 5,
    progress: ProgressCallback | None = None,
) -> Path:
    spec = MODEL_SPECS[model]
    target = repository_path(model_root)
    target.mkdir(parents=True, exist_ok=True)
    total_files = len(spec.files)
    for index, filename in enumerate(spec.files):
        if progress:
            progress(index / total_files, f"下载 {model} · {index + 1}/{total_files}")
        download_file(
            base_url.rstrip("/") + "/" + filename,
            target / filename,
            retries,
            lambda fraction, index=index: progress(
                (index + fraction) / total_files,
                f"下载 {model} · {index + 1}/{total_files}",
            ) if progress else None,
        )
    (target / f"{model}.yaml").write_text(spec.bag, "utf-8")
    hashes = {filename: verify_weight(target / filename) for filename in spec.files}
    marker_path(model_root, model).write_text(json.dumps({
        "model": model,
        "source": base_url,
        "files": hashes,
        "checksum": "sha256",
    }, ensure_ascii=False, indent=2), "utf-8")
    verify_model(model, model_root)
    if progress:
        progress(1.0, f"{model} 下载并校验完成")
    return target


def cli(model: str) -> int:
    parser = argparse.ArgumentParser(description=f"Download official Demucs model {model} without Hugging Face")
    parser.add_argument("--output", type=Path, default=DEFAULT_MODEL_ROOT, help="model root directory")
    parser.add_argument("--retries", type=int, default=5, choices=range(0, 11), help="retry count")
    args = parser.parse_args()
    try:
        target = download_model(
            model,
            args.output,
            retries=args.retries,
            progress=lambda fraction, message: print(f"[{fraction * 100:6.2f}%] {message}", flush=True),
        )
        print(f"Model saved to: {target}")
        return 0
    except KeyboardInterrupt:
        print("Download cancelled; the .part file is kept for resuming.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Download failed: {error}", file=sys.stderr)
        return 1
