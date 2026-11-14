"""Run with the catalog-installed Python; verify imports, inference and Mach-O targets."""
import importlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'python/worker'))
import worker
import numpy as np
import torch
import torchaudio
import onnxruntime as ort
import soundfile as sf

for name in ('demucs.api', 'librosa', 'scipy', 'sklearn', 'guitar_separator_hq.separator', 'vocal_separator'):
    importlib.import_module(name)
worker.test_onnx_cpu()
source = torch.tensor([1., 2.])
assert (source * source).tolist() == [1., 4.]
mps = torch.backends.mps.is_available()
if mps:
    assert (source.to('mps') ** 2).cpu().tolist() == [1., 4.]
with tempfile.TemporaryDirectory() as directory:
    file = Path(directory) / 'roundtrip.wav'
    source = np.sin(np.arange(4410) * .03).astype(np.float32)
    sf.write(file, source, 44100, subtype='FLOAT')
    actual, rate = sf.read(file)
    assert rate == 44100 and np.allclose(actual, source)

magic = {bytes.fromhex(s) for s in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}
checked, bad, seen = [], [], set()
roots = [Path(sys.prefix) / 'lib/python3.12/site-packages', Path(sys.base_prefix)]
for root in roots:
    for file in root.rglob('*'):
        if not file.is_file() or file.is_symlink() or file.resolve() in seen:
            continue
        seen.add(file.resolve())
        with file.open('rb') as handle:
            if handle.read(4) not in magic:
                continue
        arches = subprocess.check_output(['/usr/bin/lipo', '-archs', str(file)], text=True).split()
        versions = []
        if 'arm64' in arches:
            commands = subprocess.check_output(['/usr/bin/otool', '-arch', 'arm64', '-l', str(file)], text=True)
            for block in commands.split('Load command'):
                field = 'minos' if 'LC_BUILD_VERSION' in block else 'version' if 'LC_VERSION_MIN_MACOSX' in block else None
                if field:
                    match = re.search(r'^\s*' + field + r'\s+(\d+(?:\.\d+)+)', block, re.M)
                    if match:
                        versions.append(match[1])
        item = {'path': str(file), 'architectures': arches, 'minimumVersions': versions}
        checked.append(item)
        if not versions or any(tuple(map(int, (v + '.0.0').split('.')[:3])) > (13, 4, 0) for v in versions):
            bad.append(item)
print(json.dumps({
    'versions': {'python': sys.version.split()[0], 'torch': torch.__version__, 'torchaudio': torchaudio.__version__, 'onnxruntime': ort.__version__, 'numpy': np.__version__},
    'onnxInference': True, 'cpuTensor': True, 'mpsTensor': mps, 'audioRoundtrip': True,
    'nativeBinariesChecked': len(checked), 'incompatibleBinaries': bad, 'binaries': checked,
}, indent=2))
if bad:
    raise SystemExit('MACOS_13_4_BINARY_COMPATIBILITY_FAILED')
