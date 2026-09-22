#!/usr/bin/env python3
"""Build and validate the missing Intel wheel; never publish or modify release pins."""
import argparse
import hashlib
from email.parser import BytesParser
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SDIST_URL = "https://files.pythonhosted.org/packages/f8/fc/6d3ae11de657a77c3fba5b036809032e2acbfc2879765a6bf19e49fbf96c/sphn-0.1.12.tar.gz"
SDIST_SHA256 = "216c5f3179107080a571401694abc071cdf6059c86e8b70c8bd188e519f0ac09"
FILENAME = "sphn-0.1.12-cp312-cp312-macosx_13_0_x86_64.whl"


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(args, *, cwd=None, env=None, capture=False):
    return subprocess.run([str(value) for value in args], cwd=cwd, env=env, check=True,
                          text=True, capture_output=capture, timeout=3600)


def supports_macos13(filename):
    platforms = filename.removesuffix(".whl").rsplit("-", 1)[-1].split(".")
    if platforms == ["any"]:
        return True
    for value in platforms:
        tag = re.fullmatch(r"macosx_(\d+)_(\d+)_(x86_64|intel|fat32|fat64|universal|universal2)", value)
        if tag and (int(tag[1]), int(tag[2])) <= (13, 0):
            return True
    return False


def wheel_metadata(artifact):
    with zipfile.ZipFile(artifact) as archive:
        names = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(names) != 1:
            raise RuntimeError(f"INTEL_RUNTIME_WHEEL_METADATA_INVALID:{artifact.name}")
        return BytesParser().parsebytes(archive.read(names[0]))


def ensure_deployment_wheels(output, local_lock, builder_python, work, environment):
    # A macOS 15 runner may choose an Accelerate wheel requiring macOS 14 even
    # when that release also ships a compatible macOS 10.14 wheel (e.g. SciPy).
    # Re-download only from the existing hashed lock with the explicit target.
    normalize = lambda name: re.sub(r"[-_.]+", "-", name.lower())
    lines = local_lock.read_text().replace("\\\n", " ").splitlines()
    for artifact in sorted(output.glob("*.whl")):
        if supports_macos13(artifact.name):
            continue
        metadata = wheel_metadata(artifact)
        requirement = next((line for line in lines if (match := re.match(r"^([\w.-]+)==", line))
                            and normalize(match[1]) == normalize(metadata["Name"])), None)
        if not requirement or "--hash=sha256:" not in requirement:
            raise RuntimeError(f"INTEL_RUNTIME_DEPLOYMENT_TARGET_INVALID:{artifact.name}")
        target = work / "macos13-wheels" / normalize(metadata["Name"])
        target.mkdir(parents=True)
        requirement_file = target / "requirement.txt"
        requirement_file.write_text(requirement + "\n")
        run([builder_python, "-m", "pip", "download", "--require-hashes", "--no-deps", "--only-binary=:all:",
             "--platform", "macosx_13_0_x86_64", "--python-version", "3.12", "--implementation", "cp", "--abi", "cp312",
             "--dest", target, "--requirement", requirement_file], env=environment)
        replacements = list(target.glob("*.whl"))
        if len(replacements) != 1 or not supports_macos13(replacements[0].name):
            raise RuntimeError(f"INTEL_RUNTIME_DEPLOYMENT_TARGET_INVALID:{artifact.name}")
        replacement_metadata = wheel_metadata(replacements[0])
        if (normalize(replacement_metadata["Name"]), replacement_metadata["Version"]) != (normalize(metadata["Name"]), metadata["Version"]):
            raise RuntimeError(f"INTEL_RUNTIME_DEPLOYMENT_WHEEL_MISMATCH:{artifact.name}")
        shutil.copyfile(replacements[0], output / replacements[0].name)
        artifact.unlink()


def verify_extension(binary):
    architecture = run(["/usr/bin/lipo", "-archs", binary], capture=True).stdout.strip()
    if architecture != "x86_64":
        raise RuntimeError(f"INTEL_WHEEL_WRONG_ARCHITECTURE:{architecture}")
    libraries = run(["/usr/bin/otool", "-L", binary], capture=True).stdout.splitlines()[1:]
    for line in libraries:
        dependency = line.strip().split(" (", 1)[0]
        if not dependency.startswith(("/usr/lib/", "/System/Library/")):
            raise RuntimeError(f"INTEL_WHEEL_NON_SYSTEM_DYLIB:{dependency}; Opus must be statically linked")
    commands = run(["/usr/bin/otool", "-l", binary], capture=True).stdout
    versions = re.findall(r"\b(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)", "\n".join(
        block for block in commands.split("Load command")
        if "LC_BUILD_VERSION" in block or "LC_VERSION_MIN_MACOSX" in block))
    if not versions or any(tuple(map(int, version.split(".")[:2])) > (13, 0) for version in versions):
        raise RuntimeError(f"INTEL_WHEEL_DEPLOYMENT_TARGET_INVALID:{versions}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "out/runtime-wheel-macos-x64")
    parser.add_argument("--release-tag", default="runtime-wheels-sphn-0.1.12-r1")
    parser.add_argument("--cpu-reference", type=Path, default=ROOT / "out/cpu-reference/reference.zip")
    parser.add_argument("--cpu-reference-pin", type=Path, default=ROOT / "python/runtime/cpu-reference.json")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "x86_64" or sys.version_info[:2] != (3, 12):
        raise RuntimeError("INTEL_WHEEL_NATIVE_BUILD_REQUIRED: run on a native Intel Mac with CPython 3.12")
    translated = subprocess.run(["/usr/sbin/sysctl", "-in", "sysctl.proc_translated"], text=True, capture_output=True)
    if translated.stdout.strip() == "1":
        raise RuntimeError("INTEL_WHEEL_NATIVE_BUILD_REQUIRED: Rosetta does not count as native Intel validation")
    if not re.fullmatch(r"runtime-wheels-sphn-0\.1\.12-r[1-9]\d*", args.release_tag):
        raise RuntimeError("Use a versioned, immutable runtime-wheels-sphn-0.1.12-rN release tag")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError("INTEL_WHEEL_OUTPUT_NOT_EMPTY: use a clean output directory to exclude stale artifacts")
    if not args.cpu_reference_pin.is_file() or not args.cpu_reference.is_file():
        raise RuntimeError("INTEL_RELEASE_BLOCKED: reviewed CPU reference pin and real waveform archive are required")
    reference_pin = json.loads(args.cpu_reference_pin.read_text())
    policy_sha = digest(ROOT / "python/runtime/cpu-comparison-policy.json")
    if (reference_pin.get("schema") != 1 or reference_pin.get("protocol") != "bandbuddy-cpu-output-v1"
            or reference_pin.get("policySha256") != policy_sha or reference_pin.get("sha256") != digest(args.cpu_reference)):
        raise RuntimeError("INTEL_RELEASE_BLOCKED: CPU reference hash or protocol does not match its reviewed pin")
    uv = ROOT / "resources/bin/uv"
    if not uv.is_file():
        raise RuntimeError("Run pnpm tools:fetch on this Intel runner first")
    environment = {**os.environ, "MACOSX_DEPLOYMENT_TARGET": "13.0", "LIBOPUS_STATIC": "1",
                   "LIBOPUS_NO_PKG": "1", "RUSTUP_TOOLCHAIN": "1.85.1"}
    for key in ["OPUS_LIB_DIR", "LIBOPUS_LIB_DIR"]:
        environment.pop(key, None)
    if not run(["rustc", "--version"], env=environment, capture=True).stdout.startswith("rustc 1.85.1 "):
        raise RuntimeError("INTEL_WHEEL_PINNED_RUST_REQUIRED: install Rust 1.85.1")
    with tempfile.TemporaryDirectory(prefix="bandbuddy-intel-wheel-") as temporary:
        work = Path(temporary)
        archive = work / "sphn.tar.gz"
        with urllib.request.urlopen(SDIST_URL, timeout=120) as response, archive.open("wb") as target:
            shutil.copyfileobj(response, target)
        if digest(archive) != SDIST_SHA256:
            raise RuntimeError("INTEL_WHEEL_SDIST_HASH_MISMATCH")
        with tarfile.open(archive) as source:
            source.extractall(work, filter="data")
        source = work / "sphn-0.1.12"
        builder = work / "builder"
        run([uv, "venv", "--python", sys.executable, builder])
        builder_python = builder / "bin/python"
        environment["PATH"] = str(builder / "bin") + os.pathsep + environment.get("PATH", "")
        run([uv, "pip", "sync", "--python", builder_python, "--require-hashes", "--only-binary", ":all:",
             ROOT / "python/runtime/wheel-build-tools.lock"])
        run([builder / "bin/maturin", "build", "--release", "--locked", "--target", "x86_64-apple-darwin",
             "--interpreter", builder_python, "--out", work / "wheels"], cwd=source, env=environment)
        built = work / "wheels" / FILENAME
        if not built.is_file():
            raise RuntimeError(f"INTEL_WHEEL_TAG_MISMATCH: expected {FILENAME}")
        wheel = output / FILENAME
        shutil.copyfile(built, wheel)
        with zipfile.ZipFile(wheel) as archive:
            extensions = [name for name in archive.namelist() if name.endswith(".so")]
            if not extensions:
                raise RuntimeError("INTEL_WHEEL_EXTENSION_MISSING")
            for index, name in enumerate(extensions):
                binary = work / f"extension-{index}.so"
                binary.write_bytes(archive.read(name))
                verify_extension(binary)
        inputs = (ROOT / "python/runtime/macos-x64.in").read_text()
        inputs = re.sub(r"(?m)^sphn==0\.1\.12$", f"sphn @ {wheel.as_uri()}", inputs)
        local_input = work / "runtime.in"
        local_input.write_text(inputs)
        local_lock = work / "runtime.lock"
        run([uv, "pip", "compile", "--python", sys.executable, "--python-version", "3.12",
             "--generate-hashes", "--exclude-newer", "2026-09-22T00:00:00Z",
             "--output-file", local_lock, local_input], env=environment)
        # A few dependencies publish only pure-Python sdists. Build them here,
        # never on end-user machines; native packages must match upstream wheel
        # hashes except for the explicitly audited sphn build above.
        upstream_hashes = set(re.findall(r"--hash=sha256:([a-f0-9]{64})", local_lock.read_text()))
        run([builder_python, "-m", "pip", "wheel", "--require-hashes", "--no-deps",
             "--wheel-dir", output, "--requirement", local_lock], env=environment)
        ensure_deployment_wheels(output, local_lock, builder_python, work, environment)
        entries = []
        for artifact in sorted(output.glob("*.whl")):
            checksum = digest(artifact)
            with zipfile.ZipFile(artifact) as archive:
                if artifact.name != FILENAME and checksum not in upstream_hashes:
                    if not artifact.name.endswith("-none-any.whl") or any(name.endswith((".so", ".dylib", ".pyd", ".dll")) for name in archive.namelist()):
                        raise RuntimeError(f"INTEL_RUNTIME_UNPINNED_NATIVE_BUILD:{artifact.name}")
                metadata_files = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
                if len(metadata_files) != 1:
                    raise RuntimeError(f"INTEL_RUNTIME_WHEEL_METADATA_INVALID:{artifact.name}")
                metadata = BytesParser().parsebytes(archive.read(metadata_files[0]))
            url = f"https://github.com/dourgey/BandBuddy/releases/download/{args.release_tag}/{artifact.name}"
            entries.append(f"{metadata['Name']} @ {url}#sha256={checksum} --hash=sha256:{checksum}")
        # Re-resolve strictly against the complete built wheelhouse. This fails
        # if any transitive dependency is absent or incompatible with CPython 3.12.
        binary_lock = work / "binary-runtime.lock"
        run([uv, "pip", "compile", "--python", sys.executable, "--only-binary", ":all:",
             "--no-index", "--find-links", output, "--generate-hashes", "--output-file", binary_lock,
             ROOT / "python/runtime/macos-x64.in"], env=environment)
        runtime = work / "runtime"
        run([uv, "venv", "--python", sys.executable, runtime])
        run([uv, "pip", "sync", "--python", runtime / "bin/python", "--require-hashes",
             "--only-binary", ":all:", "--no-index", "--find-links", output, binary_lock], env=environment)
        smoke = """
import importlib, tempfile, pathlib, numpy as np, torch, sphn
for name in ['torchaudio','demucs','scipy','soundfile','librosa','yaml','einops','beartype','rotary_embedding_torch','packaging','onnxruntime','numba','llvmlite']:
    importlib.import_module(name)
assert torch.mm(torch.eye(2), torch.eye(2)).sum().item() == 2
with tempfile.TemporaryDirectory() as root:
    file = str(pathlib.Path(root) / '中文 路径.wav')
    sphn.write_wav(file, np.zeros(4800, dtype=np.float32), 48000)
    data, rate = sphn.read(file)
    assert rate == 48000 and data.shape[-1] == 4800
"""
        run([runtime / "bin/python", "-c", smoke], env=environment)
        model_root = work / "中文 模型 (Intel)"
        run([runtime / "bin/python", ROOT / "python/worker/worker.py", "ensure-model", "--model-root", model_root], env=environment)
        probe = run([runtime / "bin/python", ROOT / "python/worker/worker.py", "probe", "--model-root", model_root,
                     "--full-self-test", "--device", "cpu"], env=environment, capture=True)
        (output / "runtime-self-test.jsonl").write_text(probe.stdout)
        results = [json.loads(line) for line in probe.stdout.splitlines() if line.startswith("{")]
        result = next((item for item in reversed(results) if item.get("type") == "result"), {})
        check = result.get("selfTest", {})
        if (not result.get("dependenciesReady") or not result.get("modelReady")
                or check.get("device") != "cpu" or not all(check.get(key) is True for key in
                    ("ran", "ok", "modelInference", "onnxCpuInference"))
                or check.get("guitarQualities") != ["fast", "balanced", "high"]):
            raise RuntimeError("INTEL_RUNTIME_FULL_INFERENCE_FAILED")
        comparison_path = output / "macos-x64-cpu-comparison.json"
        comparison_run = subprocess.run([str(runtime / "bin/python"), str(ROOT / "scripts/runtime-cpu-reference.py"), "compare",
            "--model-root", str(model_root), "--reference", str(args.cpu_reference.resolve()), "--pin", str(args.cpu_reference_pin.resolve()),
            "--report", str(comparison_path)], env=environment, text=True, capture_output=True, timeout=3600)
        (output / "cpu-comparison.log").write_text(comparison_run.stdout + comparison_run.stderr)
        if comparison_run.returncode != 0 or not comparison_path.is_file():
            raise RuntimeError("INTEL_RELEASE_BLOCKED: CPU waveform comparison failed; retain the report/log for review without relaxing thresholds")
        comparison = json.loads(comparison_path.read_text())
        if comparison.get("passed") is not True or comparison.get("referenceSha256") != reference_pin["sha256"]:
            raise RuntimeError("INTEL_RELEASE_BLOCKED: CPU waveform comparison did not pass against the reviewed reference")
        url = f"https://github.com/dourgey/BandBuddy/releases/download/{args.release_tag}/{FILENAME}"
        lock = "# Validated complete CPython 3.12 Intel wheelhouse. No source builds or mutable indexes.\n" + "\n".join(entries) + "\n"
        wheel_hash = digest(wheel)
        (output / "macos-x64.lock").write_text(lock)
        manifest = {"schema": 1, "wheels": {"darwin-x64-cp312": {
            "name": "sphn", "version": "0.1.12", "filename": FILENAME, "url": url, "sha256": wheel_hash}}}
        (output / "runtime-wheels.json").write_text(json.dumps(manifest, indent=2) + "\n")
        evidence = {"architecture": platform.machine(), "platform": sys.platform, "python": "3.12",
                    "macOS": platform.mac_ver()[0], "deploymentTarget": "13.0", "staticOpus": True,
                    "runtimeImports": True, "audioRoundTrip": True, "fullSelfTest": check, "wheelSha256": wheel_hash,
                    "cpuComparison": {"passed": True, "report": comparison_path.name, "sha256": digest(comparison_path),
                                      "referenceSha256": reference_pin["sha256"], "policySha256": policy_sha},
                    "lockSha256": hashlib.sha256(lock.encode()).hexdigest(), "sourceSha256": SDIST_SHA256,
                    "commit": os.environ.get("GITHUB_SHA"), "runner": os.environ.get("RUNNER_NAME")}
        (output / "macos-x64-validation.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Validated Intel runtime artifacts in {output}. Review and publish the complete immutable wheelhouse before committing manifest, lock and evidence; nothing has been published.")


if __name__ == "__main__":
    main()
