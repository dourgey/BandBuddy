"""Resolve immutable desktop wheel profiles at release time, never on user PCs.

uv supplies all transitive dependencies and upstream wheel hashes. Public mirror
links are admitted only when their index advertises the same filename AND hash.
The committed catalog is the application's trust root; refresh it deliberately.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import subprocess
import tomllib
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.links = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a': self.links.extend(v for k, v in attrs if k == 'href' and v)

def mirrors(name, filename, digest):
    found = []
    for base in ('https://mirrors.aliyun.com/pypi/simple/', 'https://pypi.tuna.tsinghua.edu.cn/simple/'):
        index = base + name + '/'
        try:
            with urlopen(Request(index, headers={'User-Agent': 'BandBuddy-release/1'}), timeout=12) as response:
                parser = Links(); parser.feed(response.read(8 * 1024 * 1024).decode('utf-8'))
            for link in parser.links:
                url = urljoin(index, link); parts = urlsplit(url)
                if unquote(parts.path.rsplit('/', 1)[-1]) == filename and parts.fragment == 'sha256=' + digest:
                    found.append(url.split('#')[0]); break
        except Exception:
            pass  # An unavailable mirror is omitted, never invented.
    return found

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', choices=['win32-x64', 'darwin-arm64'], required=True)
    parser.add_argument('--backend', choices=['cpu', 'cu126', 'cu128', 'cu129', 'cu130'], default='cpu')
    parser.add_argument('--uv', default=str(ROOT / 'resources/bin' / ('uv.exe' if __import__('os').name == 'nt' else 'uv')))
    parser.add_argument('--mirrors', action='store_true')
    parser.add_argument('--reuse-resolution', action='store_true', help='Re-select wheel tags from the existing exact resolution without updating versions')
    args = parser.parse_args()
    cache = ROOT / '.codex-tmp/runtime-locks'; cache.mkdir(parents=True, exist_ok=True)
    key = args.target + '-' + args.backend
    source = cache / (key + '.in')
    onnx = 'onnxruntime==1.28.0' if args.backend == 'cpu' else 'onnxruntime-gpu==' + ('1.28.0' if args.backend == 'cu130' else '1.26.0')
    source.write_text((ROOT / 'python/runtime/desktop.in').read_text(encoding='utf-8') + '\n' + onnx + '\n', encoding='utf-8')
    lock = cache / ('pylock.' + key + '.toml')
    platform = 'x86_64-pc-windows-msvc' if args.target == 'win32-x64' else 'aarch64-apple-darwin'
    command = [args.uv, 'pip', 'compile', str(source), '--python-platform', platform, '--python-version', '3.12', '--format', 'pylock.toml', '--output-file', str(lock), '--only-binary', ':all:', '--quiet']
    if args.target == 'win32-x64': command += ['--torch-backend', args.backend]
    if not args.reuse_resolution:
        subprocess.run(command, check=True, env={**os.environ, **({'MACOSX_DEPLOYMENT_TARGET': '14.0'} if args.target == 'darwin-arm64' else {})})
    data = tomllib.loads(lock.read_text(encoding='utf-8'))
    artifacts = []
    for package in data['packages']:
        candidates = package.get('wheels', [])
        if not candidates: raise RuntimeError('CI_WHEEL_BUILD_REQUIRED:' + package['name'])
        def score(wheel):
            filename = unquote(urlsplit(wheel['url']).path.rsplit('/', 1)[-1])
            # A pure fallback (notably SoundFile) omits native DLL/dylib payloads.
            native = filename.endswith('-win_amd64.whl') if args.target == 'win32-x64' else ('macosx_' in filename and ('arm64' in filename or 'universal2' in filename))
            return (0 if native else 1, 0 if 'cp312' in filename else 1 if 'abi3' in filename else 2, filename)
        wheel = sorted(candidates, key=score)[0]
        filename = unquote(urlsplit(wheel['url']).path.rsplit('/', 1)[-1])
        if not filename.endswith('.whl'): raise RuntimeError('SOURCE_BUILD_FORBIDDEN')
        size = wheel.get('size')
        if not size:
            candidates = [wheel['url'].replace('download-r2.pytorch.org', 'download.pytorch.org'), wheel['url']]
            for candidate in candidates:
                try:
                    with urlopen(Request(candidate, headers={'Range': 'bytes=0-0', 'User-Agent': 'uv/0.11.29'}), timeout=30) as response:
                        size = int(response.headers['Content-Range'].split('/')[-1]) if response.headers.get('Content-Range') else int(response.headers['Content-Length'])
                    wheel['url'] = candidate; break
                except Exception:
                    if candidate == candidates[-1]: raise
        artifacts.append({'id': package['name'], 'version': package['version'], 'filename': filename, 'size': size, 'expandedSize': size * 5, 'sha256': wheel['hashes']['sha256'], 'urls': [wheel['url']]})
    if args.mirrors:
        with ThreadPoolExecutor(max_workers=6) as executor:
            extras = list(executor.map(lambda a: mirrors(a['id'], a['filename'], a['sha256']), artifacts))
        for artifact, extra in zip(artifacts, extras): artifact['urls'] = extra + artifact['urls']
    # Pin the exact interpreter build, with its upstream release checksum.
    triple = 'x86_64-pc-windows-msvc' if args.target == 'win32-x64' else 'aarch64-apple-darwin'
    filename = f'cpython-3.12.13+20260623-{triple}-install_only_stripped.tar.gz'
    base = 'https://releases.astral.sh/github/python-build-standalone/releases/download/20260623/'
    url = base + filename.replace('+', '%2B')
    metadata_path = cache / 'python-builds.json'
    if not metadata_path.exists():
        with urlopen('https://raw.githubusercontent.com/astral-sh/uv/0.11.29/crates/uv-python/download-metadata.json', timeout=40) as response: metadata_path.write_bytes(response.read())
    builds = json.loads(metadata_path.read_text(encoding='utf-8'))
    build = next(b for b in builds.values() if b.get('build') == '20260623' and b.get('major') == 3 and b.get('minor') == 12 and b.get('patch') == 13 and b.get('variant') is None and b['arch']['family'] == ('x86_64' if args.target == 'win32-x64' else 'aarch64') and b['os'] == ('windows' if args.target == 'win32-x64' else 'darwin'))
    mirror = 'https://registry.npmmirror.com/-/binary/python-build-standalone/20260623/' + filename.replace('+', '%2B')
    urls = [mirror, build['url'], url]
    archive = cache / filename
    if not archive.exists():
        for source_url in urls:
            try:
                with urlopen(source_url, timeout=30) as response, archive.open('wb') as output:
                    while chunk := response.read(1024 * 1024): output.write(chunk)
                if hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() != build['sha256']: raise RuntimeError('PYTHON_UPSTREAM_HASH_MISMATCH')
                url = source_url; break
            except Exception:
                archive.unlink(missing_ok=True)
                if source_url == urls[-1]: raise
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    if digest != build['sha256']: raise RuntimeError('PYTHON_UPSTREAM_HASH_MISMATCH')
    # Probe this exact file even when the verified archive is already cached.
    mirror_urls = []
    try:
        with urlopen(Request(mirror, headers={'Range': 'bytes=0-0'}), timeout=15) as response:
            if response.status in (200, 206) and 'text/html' not in response.headers.get('Content-Type', ''): mirror_urls.append(mirror)
    except Exception:
        pass
    interpreter = {'id': 'python', 'version': '3.12.13', 'filename': filename, 'size': archive.stat().st_size, 'expandedSize': 180 * 1024 * 1024, 'sha256': digest, 'urls': mirror_urls + [build['url']]}
    profile = {'schema': 1, 'id': key, 'target': args.target, 'backend': args.backend, 'python': interpreter, 'wheels': artifacts,
               'minimumSystem': '10.0' if args.target == 'win32-x64' else '14.0',
               'minimumDriver': {'cpu': None, 'cu126': '560.76', 'cu128': '572.61', 'cu129': '576.02', 'cu130': '580.88'}[args.backend],
               'minimumComputeCapability': None if args.backend == 'cpu' else '7.5'}
    output = ROOT / 'resources/runtime-catalog'; output.mkdir(exist_ok=True)
    (output / (key + '.json')).write_text(json.dumps(profile, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'profile': key, 'wheels': len(artifacts), 'bytes': sum(a['size'] for a in artifacts), 'mirrored': sum(len(a['urls']) > 1 for a in artifacts)}))

if __name__ == '__main__': main()
