"""Bound long-song accumulation buffers without changing inference policies."""
from __future__ import annotations

import atexit
import os
from pathlib import Path
import shutil
import tempfile
import weakref

import numpy as np

_directory: Path | None = None
_mappings: list[weakref.ReferenceType] = []
BLOCK_FRAMES = 44_100 * 15


def _cleanup() -> None:
    for reference in _mappings:
        array = reference()
        if array is not None:
            array.flush()
            array._mmap.close()
    if _directory is not None:
        shutil.rmtree(_directory, ignore_errors=True)


atexit.register(_cleanup)


def zeros(shape: tuple[int, ...] | int) -> np.ndarray:
    global _directory
    shape = (shape,) if isinstance(shape, int) else shape
    threshold = max(1, int(os.environ.get("BANDBUDDY_MEMMAP_MB", "64"))) * 1024 * 1024
    size = int(np.prod(shape)) * np.dtype(np.float32).itemsize
    if size < threshold:
        return np.zeros(shape, dtype=np.float32)
    if _directory is None:
        parent = os.environ.get("BANDBUDDY_MEMORY_DIR")
        if parent:
            Path(parent).mkdir(parents=True, exist_ok=True)
        _directory = Path(tempfile.mkdtemp(prefix="bandbuddy-memory-", dir=parent))
    # A newly extended file is zero-filled by the OS; don't touch every page.
    array = np.memmap(_directory / f"buffer-{len(_mappings)}.f32", mode="w+", dtype=np.float32, shape=shape)
    _mappings.append(weakref.ref(array))
    return array


def contiguous(array: np.ndarray) -> np.ndarray:
    if array.flags.c_contiguous and array.dtype == np.float32:
        return array
    result = zeros(array.shape)
    for start in range(0, array.shape[-1], BLOCK_FRAMES):
        result[..., start:start + BLOCK_FRAMES] = array[..., start:start + BLOCK_FRAMES]
    return result


def finite(array: np.ndarray) -> bool:
    return all(np.isfinite(array[..., start:start + BLOCK_FRAMES]).all()
               for start in range(0, array.shape[-1], BLOCK_FRAMES))


def divide_in_place(result: np.ndarray, divisor: np.ndarray) -> np.ndarray:
    for start in range(0, result.shape[-1], BLOCK_FRAMES):
        end = start + BLOCK_FRAMES
        np.divide(result[..., start:end], np.maximum(divisor[..., start:end], 1e-10), out=result[..., start:end])
    return result
