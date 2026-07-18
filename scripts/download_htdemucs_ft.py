#!/usr/bin/env python3
"""Download the official four-model htdemucs_ft bag without Hugging Face."""

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python" / "worker"))
from model_download import cli  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(cli("htdemucs_ft"))
