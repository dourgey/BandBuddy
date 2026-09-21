# BandBuddy third-party notices

BandBuddy bundles or installs the following third-party software. The application itself is not endorsed by these projects.

- Electron 43.1.1 — MIT License — https://github.com/electron/electron
- React 19.2.7 — MIT License — https://github.com/facebook/react
- Signalsmith Stretch 1.3.2 — MIT License — https://github.com/Signalsmith-Audio/signalsmith-stretch
- Signalsmith Linear 0.3.1 — MIT License — https://github.com/Signalsmith-Audio/linear
- NeuralAmpModelerCore v0.5.4 — MIT License — https://github.com/sdatkinson/NeuralAmpModelerCore. BandBuddy uses its A2-capable DSP core for local NAM model inference; user-imported `.nam` and IR files are not bundled.
- better-sqlite3 / SQLite — MIT / Public Domain — https://github.com/WiseLibs/better-sqlite3
- FFmpeg n8.1.2 Windows x64 LGPL shared build — LGPL 2.1 or later — https://ffmpeg.org and https://github.com/BtbN/FFmpeg-Builds. The full build license is installed as `resources/bin/FFmpeg-LICENSE.txt`; the build deliberately uses shared libraries.
- FFmpeg/FFprobe macOS arm64 static builds from `ffmpeg-static` release `b6.1.1` — GPL 3.0 or later — https://ffmpeg.org and https://github.com/eugeneware/ffmpeg-static. Each macOS package includes the upstream build README and license in its `Resources/bin` directory; corresponding source and build provenance are linked from those files and the upstream release.
- uv 0.11.29 — Apache-2.0 OR MIT — https://github.com/astral-sh/uv
- CPython 3.12 — Python Software Foundation License — installed on demand by uv.
- PyTorch and torchaudio 2.11.0 — BSD-3-Clause — installed on demand into the private Windows x64 or macOS arm64 runtime.
- Demucs 4.1.0 — MIT License — installed on demand into the private runtime. Its copyright and license notice are reproduced below.
- BandBuddy 2.0 separation weight bundle — not included in BandBuddy installers or source distributions. The application downloads four fixed files from the public ModelScope repository `Zzzzzzorz/BandBuddy-Models`, branch `v2.0.0`, and verifies their pinned byte sizes and full SHA-256 values before activation. The ModelScope repository is published under GPL-3.0 and contains its own source and third-party notices: https://modelscope.cn/models/Zzzzzzorz/BandBuddy-Models
- Music-Source-Separation-Training model architecture code (pinned commit `0e5f1159fc5ea87fc13b957584e178b4977e5dd3`) — MIT License — https://github.com/ZFTurbo/Music-Source-Separation-Training. The vendored subset retains its upstream license at `python/guitar_separator_hq/_vendor/msst/LICENSE`.
- The fixed weight bundle contains the six-stem HTDemucs checkpoint, MVSep Mega 53-stem acoustic/electric guitar checkpoints, and the `listra92` Lead/Rhythm checkpoint. Provenance, original repository revisions, checksums and redistribution declarations are retained in the ModelScope repository's `README.md`, `manifest.json`, and `THIRD_PARTY_NOTICES.md`.

The generated dependency lockfile is the authoritative list of JavaScript packages. Redistribution must retain the applicable license texts and attributions.

## Signalsmith Stretch MIT License

Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Signalsmith Linear MIT License

Copyright (c) 2025 Signalsmith Audio

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Demucs MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
