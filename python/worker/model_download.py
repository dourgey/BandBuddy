#!/usr/bin/env python3
"""Install BandBuddy's pinned v2.0.1 separation bundle from ModelScope.

Every byte count and SHA-256 is compiled into the application. Downloads use
``.part`` files and HTTP Range so interrupted installs resume safely. The
bundle marker is written atomically only after all six model files and the
Demucs repository descriptor have been verified together.
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


MODEL_REPOSITORY = "Zzzzzzorz/BandBuddy-Models"
MODEL_REVISION = "v2.0.1"
MODEL_BASE_URL = (
    f"https://modelscope.cn/models/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}"
)
BUNDLE_DIRECTORY = "bandbuddy-stems-v2.0.1"
DEMUCS_MODEL_NAME = "htdemucs_6s"
DEMUCS_BAG = "models: ['5c90dfd2']\n"
CHUNK_SIZE = 1024 * 1024


class BundleFile(NamedTuple):
    key: str
    filename: str
    size: int
    sha256: str


BUNDLE_FILES: tuple[BundleFile, ...] = (
    BundleFile(
        "six_stem",
        "5c90dfd2-34c22ccb.th",
        54_996_327,
        "34c22ccb381c6f9fdbf324f04e1e2fe21aaaf293f5ded163a162697ff9a02ddd",
    ),
    BundleFile(
        "shared_acoustic_electric",
        "bs_mega_53stem_acoustic-electric_shared_mvsep.ckpt",
        102_410_137,
        "183607bffbebdb43dcb3fd583b7cbe3c77fb55aea886cbd1e3aa316d9148698c",
    ),
    BundleFile(
        "lead_rhythm_hq",
        "mbr_lead_rhythm_guitar_listra92.ckpt",
        337_073_664,
        "b3c47bca33609ca1ba0bb2d2076410bfd1eb941b051b72afc1f3e24d12b17eef",
    ),
    BundleFile(
        "acoustic_guitar_fast",
        "mdx_6s_acoustic_guitar_anvuew.onnx",
        27_147_460,
        "2bd8f2af629b279cc1a568f895ee9636f7ce2d76c69aa601e6744eaab8b4916a",
    ),
    BundleFile(
        "electric_guitar_fast",
        "mdx_6s_electric_guitar_anvuew.onnx",
        27_147_623,
        "bd6fcf40659771568ee180ea69bd4576a9c3d2423ae0f5f6f5afcc8b6a6fd938",
    ),
    BundleFile(
        "lead_rhythm_fast",
        "demucs4_lead_rhythm_guitar_drypaint.ckpt",
        109_822_623,
        "946ffd50d7f2fd87e447d880525283e88bd9061e1b428d4f1d380e764d54d618",
    ),
)

ProgressCallback = Callable[[float, str], None]


def bundle_path(model_root: Path) -> Path:
    return model_root.expanduser().resolve() / BUNDLE_DIRECTORY


def marker_path(model_root: Path) -> Path:
    return bundle_path(model_root) / ".bundle-complete.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_file(path: Path, spec: BundleFile) -> str:
    if not path.is_file():
        raise RuntimeError(f"MODEL_FILE_MISSING:{spec.key}")
    actual_size = path.stat().st_size
    if actual_size != spec.size:
        raise RuntimeError(
            f"MODEL_SIZE_MISMATCH:{spec.key}:expected={spec.size}:actual={actual_size}"
        )
    actual_hash = sha256_file(path)
    if actual_hash != spec.sha256:
        raise RuntimeError(
            f"MODEL_HASH_MISMATCH:{spec.key}:expected={spec.sha256}:actual={actual_hash}"
        )
    return actual_hash


def verify_bundle(model_root: Path, required_keys: tuple[str, ...] | None = None, *, full: bool = True) -> Path:
    target = bundle_path(model_root)
    bag = target / f"{DEMUCS_MODEL_NAME}.yaml"
    if not bag.is_file() or bag.read_text("utf-8") != DEMUCS_BAG:
        raise RuntimeError("MODEL_BAG_MISSING_OR_CHANGED")
    marker = marker_path(model_root)
    if not marker.is_file():
        raise RuntimeError("MODEL_MARKER_MISSING")
    try:
        recorded = json.loads(marker.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("MODEL_MARKER_INVALID") from error
    expected_hashes = {spec.filename: spec.sha256 for spec in BUNDLE_FILES}
    if (recorded.get("repository") != MODEL_REPOSITORY or recorded.get("revision") != MODEL_REVISION or recorded.get("files") != expected_hashes):
        raise RuntimeError("MODEL_MARKER_MISMATCH")
    selected = BUNDLE_FILES
    if required_keys is not None:
        requested = set(required_keys)
        selected = tuple(spec for spec in BUNDLE_FILES if spec.key in requested)
        if {spec.key for spec in selected} != requested:
            raise RuntimeError("MODEL_BUNDLE_KEY_UNKNOWN")
    for spec in selected:
        file = target / spec.filename
        if full:
            verify_file(file, spec)
        elif not file.is_file() or file.stat().st_size != spec.size:
            raise RuntimeError(f"MODEL_FILE_MISSING_OR_SIZE_CHANGED:{spec.key}")
    return target


def _content_length(headers: object) -> int | None:
    value = getattr(headers, "get", lambda _key: None)("Content-Length")
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _download_once(
    spec: BundleFile,
    destination: Path,
    progress: Callable[[float], None],
) -> None:
    partial = destination.with_name(destination.name + ".part")
    if partial.is_file() and partial.stat().st_size > spec.size:
        partial.unlink()
    if partial.is_file() and partial.stat().st_size == spec.size:
        try:
            verify_file(partial, spec)
        except RuntimeError:
            partial.unlink()
        else:
            os.replace(partial, destination)
            progress(1.0)
            return
    offset = partial.stat().st_size if partial.is_file() else 0
    headers = {"User-Agent": "BandBuddy/2.0.1"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = Request(f"{MODEL_BASE_URL}/{spec.filename}", headers=headers)
    with urlopen(request, timeout=45, context=ssl.create_default_context()) as response:
        status = getattr(response, "status", response.getcode())
        resumed = offset > 0 and status == 206
        content_range = response.headers.get("Content-Range")
        if resumed and content_range and not content_range.startswith(f"bytes {offset}-"):
            partial.unlink(missing_ok=True)
            raise OSError(f"MODEL_RANGE_MISMATCH:{spec.key}")
        if not resumed:
            offset = 0
        length = _content_length(response.headers)
        total = offset + length if length is not None else spec.size
        mode = "ab" if resumed else "wb"
        written = offset
        with partial.open(mode) as handle:
            while True:
                block = response.read(CHUNK_SIZE)
                if not block:
                    break
                handle.write(block)
                written += len(block)
                progress(min(0.99, written / spec.size))
            handle.flush()
            os.fsync(handle.fileno())
    if total != spec.size or written != spec.size:
        raise OSError(
            f"MODEL_DOWNLOAD_INCOMPLETE:{spec.key}:{written}/{spec.size}:server={total}"
        )
    verify_file(partial, spec)
    os.replace(partial, destination)
    progress(1.0)


def download_file(
    spec: BundleFile,
    destination: Path,
    *,
    retries: int,
    progress: Callable[[float], None],
) -> None:
    if destination.is_file():
        try:
            verify_file(destination, spec)
            progress(1.0)
            return
        except RuntimeError:
            destination.unlink()
    last_error: BaseException | None = None
    retry_types = (HTTPError, URLError, TimeoutError, OSError, ssl.SSLError, RuntimeError)
    for attempt in range(retries + 1):
        try:
            _download_once(spec, destination, progress)
            return
        except retry_types as error:
            last_error = error
            if isinstance(error, HTTPError) and error.code in (404, 416):
                if error.code == 416:
                    destination.with_name(destination.name + ".part").unlink(missing_ok=True)
                else:
                    break
            if "MODEL_HASH_MISMATCH" in str(error):
                destination.with_name(destination.name + ".part").unlink(missing_ok=True)
            if attempt >= retries:
                break
            time.sleep(min(10.0, 1.0 + attempt * 1.5))
    raise RuntimeError(f"MODEL_DOWNLOAD_FAILED:{spec.key}:{last_error}") from last_error


def install_bundle(
    model_root: Path,
    *,
    retries: int = 8,
    progress: ProgressCallback | None = None,
) -> Path:
    target = bundle_path(model_root)
    target.mkdir(parents=True, exist_ok=True)
    # A repair must not invalidate a working installation while downloading.
    # The old marker is harmless: every inference still verifies pinned hashes.
    total_bytes = sum(spec.size for spec in BUNDLE_FILES)
    completed_bytes = 0
    hashes: dict[str, str] = {}
    for index, spec in enumerate(BUNDLE_FILES):
        if progress:
            progress(completed_bytes / total_bytes, f"正在准备分轨资源 {index + 1}/{len(BUNDLE_FILES)}")
        download_file(
            spec,
            target / spec.filename,
            retries=retries,
            progress=lambda fraction, completed_bytes=completed_bytes, spec=spec, index=index: progress(
                (completed_bytes + fraction * spec.size) / total_bytes,
                f"正在准备分轨资源 {index + 1}/{len(BUNDLE_FILES)}",
            ) if progress else None,
        )
        hashes[spec.filename] = verify_file(target / spec.filename, spec)
        completed_bytes += spec.size

    bag = target / f"{DEMUCS_MODEL_NAME}.yaml"
    bag_partial = bag.with_name(bag.name + ".part")
    bag_partial.write_text(DEMUCS_BAG, "utf-8")
    os.replace(bag_partial, bag)
    document = {
        "schema": 2,
        "repository": MODEL_REPOSITORY,
        "revision": MODEL_REVISION,
        "files": hashes,
        "checksum": "sha256",
    }
    marker = marker_path(model_root)
    marker_partial = marker.with_name(marker.name + ".part")
    marker_partial.write_text(json.dumps(document, ensure_ascii=False, indent=2), "utf-8")
    os.replace(marker_partial, marker)
    verified = verify_bundle(model_root)
    if progress:
        progress(1.0, "分轨资源已准备完成")
    return verified


def cli() -> int:
    parser = argparse.ArgumentParser(description="Install BandBuddy's pinned separation bundle")
    parser.add_argument("--output", type=Path, default=Path.cwd() / "models")
    parser.add_argument("--retries", type=int, default=8, choices=range(0, 11))
    args = parser.parse_args()
    try:
        target = install_bundle(
            args.output,
            retries=args.retries,
            progress=lambda fraction, message: print(
                f"[{fraction * 100:6.2f}%] {message}", flush=True
            ),
        )
        print(f"Bundle saved to: {target}")
        return 0
    except KeyboardInterrupt:
        print("Download cancelled; .part files are kept for resuming.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Download failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(cli())
