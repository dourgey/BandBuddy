#!/usr/bin/env python3
"""Export or compare pinned, deterministic CPU waveforms. Never uploads artifacts."""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("export", "compare"))
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--pin", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    profile = json.loads((ROOT / "python/runtime/cpu-comparison-policy.json").read_text())
    if os.environ.get("PYTHONHASHSEED") != str(profile["seed"]):
        os.execve(sys.executable, [sys.executable, __file__, *sys.argv[1:]], {**os.environ, "PYTHONHASHSEED": str(profile["seed"])})
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "BANDBUDDY_CPU_THREADS"):
        os.environ[name] = str(profile["cpuThreads"])
    sys.path.insert(0, str(ROOT / "python"))
    sys.path.insert(0, str(ROOT / "python/worker"))
    from cpu_reference import export_reference, read_reference, infer, compare_outputs, environment, sha256, canonical
    if args.command == "export":
        if args.reference.exists() or args.pin.exists():
            raise RuntimeError("CPU_REFERENCE_EXISTS: never overwrite an accepted baseline")
        pin = export_reference(args.reference, infer(args.model_root))
        args.pin.parent.mkdir(parents=True, exist_ok=True)
        args.pin.write_bytes(canonical(pin) + b"\n")
        print(json.dumps({"status": "reference-exported-for-review", "reference": str(args.reference), **pin}))
        return 0
    if not args.report:
        parser.error("compare requires --report")
    if not args.pin.is_file():
        raise RuntimeError("CPU_REFERENCE_BLOCKED: a reviewed reference pin is required")
    pin = json.loads(args.pin.read_text())
    metadata, reference = read_reference(args.reference, pin)
    report = compare_outputs(reference, infer(args.model_root))
    report.update({"referenceSha256": pin["sha256"], "referenceManifestSha256": sha256(canonical(metadata)),
                   "inputSha256": metadata["inputSha256"], "modelManifestSha256": metadata["modelManifestSha256"],
                   "productionCodeSha256": metadata["productionCodeSha256"], "candidateEnvironment": environment(),
                   "referenceEnvironment": metadata["environment"]})
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(canonical(report) + b"\n")
    print(json.dumps({"status": "passed" if report["passed"] else "blocked-numerical-mismatch", "report": str(args.report), "referenceSha256": pin["sha256"]}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
