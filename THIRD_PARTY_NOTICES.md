# BandBuddy third-party notices

BandBuddy bundles or installs the following third-party software. The application itself is not endorsed by these projects.

- Electron 43.1.1 — MIT License — https://github.com/electron/electron
- React 19.2.7 — MIT License — https://github.com/facebook/react
- better-sqlite3 / SQLite — MIT / Public Domain — https://github.com/WiseLibs/better-sqlite3
- FFmpeg n8.1.2 Windows x64 LGPL shared build — LGPL 2.1 or later — https://ffmpeg.org and https://github.com/BtbN/FFmpeg-Builds. The full build license is installed as `resources/bin/FFmpeg-LICENSE.txt`; the build deliberately uses shared libraries.
- FFmpeg/FFprobe macOS x64 and arm64 static builds from `ffmpeg-static` release `b6.1.1` — GPL 3.0 or later — https://ffmpeg.org and https://github.com/eugeneware/ffmpeg-static. Each macOS package includes the upstream build README and license in its `Resources/bin` directory; corresponding source and build provenance are linked from those files and the upstream release.
- uv 0.11.29 — Apache-2.0 OR MIT — https://github.com/astral-sh/uv
- CPython 3.12 — Python Software Foundation License — installed on demand by uv.
- PyTorch and torchaudio — BSD-3-Clause — installed on demand into the private runtime. Windows x64 and macOS arm64 use 2.11.0; macOS x64 uses the matching 2.2.2 pair that still provides Intel CPython 3.12 wheels.
- Demucs 4.1.0 — MIT License — installed on demand into the private runtime.
- HTDemucs model weights — downloaded only after user confirmation from the official Demucs CDN with pinned checksums; their repository license applies.

The generated dependency lockfile is the authoritative list of JavaScript packages. Redistribution must retain the applicable license texts and attributions.
