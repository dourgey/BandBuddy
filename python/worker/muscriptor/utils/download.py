"""Weight download utility with caching in ~/.cache/muscriptor/."""

import hashlib
import os
import urllib.request
from pathlib import Path
from huggingface_hub import hf_hub_download
from huggingface_hub.errors import (
    GatedRepoError,
    HfHubHTTPError,
    RepositoryNotFoundError,
)
from huggingface_hub.utils import EntryNotFoundError


_CACHE_DIR = Path.home() / ".cache" / "muscriptor"


class ModelDownloadError(RuntimeError):
    """Downloading the model weights failed for a reason the user must fix
    (typically missing HuggingFace authentication). The message is meant to
    be shown to the user as-is, without a traceback."""


def _auth_help(repo_id: str) -> str:
    return (
        f"cannot download '{repo_id}' from HuggingFace: the MuScriptor model "
        "weights are gated and require a (free) HuggingFace account.\n\n"
        f"  1. Accept the model license at https://huggingface.co/{repo_id}\n"
        "     (access is granted automatically).\n"
        "  2. Authenticate on this machine, either:\n"
        "       - run: uvx hf auth login\n"
        "       - or set the HF_TOKEN environment variable to a read token\n"
        "         from https://huggingface.co/settings/tokens\n\n"
        "See the 'HuggingFace login' section of the README for details."
    )


def download_if_necessary(url: str | Path) -> Path:
    """Resolve a weights location to a local file, downloading if necessary.

    Args:
        url: Where to find the weights:
            - ``hf://<repo_id>/<path/in/repo>`` — downloaded via huggingface_hub.
            - ``http(s)://…`` — fetched with a plain HTTP GET and cached under
              the cache dir (filename prefixed with a hash of the URL).
            - anything else (a local path, as ``str`` or ``Path``) — used as-is;
              nothing is downloaded, but the file must already exist.

    Returns:
        Path to the local file.
    """
    if isinstance(url, str) and url.startswith("hf://"):
        org, name, hf_filename = url[len("hf://") :].split("/", 2)
        repo_id = f"{org}/{name}"
        try:
            cached = hf_hub_download(repo_id=repo_id, filename=hf_filename)
        except (GatedRepoError, RepositoryNotFoundError) as e:
            # What an unauthenticated (or not-yet-approved) client gets back
            # from a gated repo, depending on hub version and repo state.
            raise ModelDownloadError(_auth_help(repo_id)) from e
        except HfHubHTTPError as e:
            if getattr(e.response, "status_code", None) in (401, 403):
                raise ModelDownloadError(_auth_help(repo_id)) from e
            raise
        return Path(cached)

    if isinstance(url, str) and url.startswith(("http://", "https://")):
        # Prefix the cache filename with a hash of the URL so two different URLs
        # that share a filename don't map to the same file.
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        filename = url.split("/")[-1].split("?")[0]
        url_hash = hashlib.sha256(url.encode()).hexdigest()[:8]
        dest = _CACHE_DIR / f"{url_hash}_{filename}"
        if dest.exists():
            return dest
        print(f"Downloading {filename} …")
        # Download to a per-process temp file, then rename: an interrupted or
        # concurrent download must never leave a partial file at `dest`, where
        # it would be mistaken for a complete one forever after.
        tmp = dest.with_name(f"{dest.name}.part{os.getpid()}")
        try:
            urllib.request.urlretrieve(url, tmp)
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
        return dest

    # Local file — nothing to download, just check it's there.
    path = Path(url)
    if not path.exists():
        raise FileNotFoundError(f"weights file not found: {path}")
    return path


def download_companion(url: str | Path, filename: str) -> Path | None:
    """Best-effort fetch of a sibling file from the same ``hf://`` repo.

    Used to grab a model's ``config.json`` next to its weights. Returns the
    local path, or ``None`` if ``url`` isn't an ``hf://`` URL or the file can't
    be fetched — repo/file missing, gated, or offline (so callers can fall back
    to other detection schemes rather than failing the whole load).
    """
    if not (isinstance(url, str) and url.startswith("hf://")):
        return None
    org, name, _ = url[len("hf://") :].split("/", 2)
    try:
        cached = hf_hub_download(repo_id=f"{org}/{name}", filename=filename)
    except (EntryNotFoundError, HfHubHTTPError):
        return None
    return Path(cached)
