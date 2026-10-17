import argparse
import contextlib
import importlib.metadata
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


class RuntimeHealthTests(unittest.TestCase):
    def test_quick_probe_uses_recent_verified_capabilities_without_importing_torch(self):
        packages = ("torch", "torchaudio", "demucs", "onnxruntime", "numpy", "librosa", "soundfile", "sphn")
        with tempfile.TemporaryDirectory() as temporary:
            Path(temporary, "bandbuddy-health.json").write_text(json.dumps({
                "schema": 2, "fingerprint": worker.health_fingerprint(Path(temporary)), "checkedAt": time.time(), "versions": {key: "test" for key in packages},
                "result": {"modelReady": True, "dependenciesReady": True, "cudaAvailable": False, "selfTest": {"ran": True, "ok": True}},
            }))
            output = io.StringIO()
            with patch.object(sys, "prefix", temporary), patch.object(importlib.metadata, "version", return_value="test"), patch("model_download.verify_bundle") as verify, contextlib.redirect_stdout(output):
                worker.command_probe(argparse.Namespace(quick=True, self_test=False, model_root=temporary))
            self.assertTrue(json.loads(output.getvalue())["dependenciesReady"])
            verify.assert_called_once_with(Path(temporary), full=False)

    def test_parser_allows_quick_status_and_explicit_cpu_self_test(self):
        args = worker.parser().parse_args(["probe", "--model-root", "中文路径", "--self-test", "--device", "cpu"])
        self.assertEqual(args.device, "cpu")
        self.assertFalse(args.quick)

    def test_unverified_expired_changed_and_legacy_cache_do_not_claim_ready(self):
        packages = ("torch", "torchaudio", "demucs", "onnxruntime", "numpy", "librosa", "soundfile", "sphn")
        for change in ({"schema": 1}, {"checkedAt": time.time() - 86401}, {"fingerprint": "old-driver"}, {"result": {"selfTest": {"ran": False, "ok": True}}}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                value = {"schema": 2, "fingerprint": worker.health_fingerprint(Path(temporary)), "checkedAt": time.time(), "versions": {key: "test" for key in packages}, "result": {"selfTest": {"ran": True, "ok": True}}}
                value.update(change)
                Path(temporary, "bandbuddy-health.json").write_text(json.dumps(value))
                import torch
                with patch.object(sys, "prefix", temporary), patch.object(importlib.metadata, "version", return_value="test"), patch.object(torch, "set_num_threads", side_effect=RuntimeError("fresh-probe-required")):
                    with self.assertRaisesRegex(RuntimeError, "fresh-probe-required"):
                        worker.command_probe(argparse.Namespace(quick=True, self_test=False, model_root=temporary))

    def test_model_file_change_invalidates_health_fingerprint(self):
        from model_download import bundle_path, BUNDLE_FILES
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            before = worker.health_fingerprint(root)
            folder = bundle_path(root)
            folder.mkdir(parents=True)
            (folder / BUNDLE_FILES[0].filename).write_bytes(b"modified")
            self.assertNotEqual(before, worker.health_fingerprint(root))

    def test_cpu_oom_is_distinct_from_gpu_oom(self):
        self.assertEqual(worker.map_error(MemoryError("allocation failed")), "CPU_OUT_OF_MEMORY")
        self.assertEqual(worker.map_error(RuntimeError("DefaultCPUAllocator: not enough memory")), "CPU_OUT_OF_MEMORY")
        self.assertEqual(worker.map_error(RuntimeError("CUDA out of memory")), "ACCELERATOR_OOM")

    def test_onnx_cpu_executes_without_an_onnx_compiler_dependency(self):
        worker.test_onnx_cpu()

    def test_release_qualification_requires_real_inference_for_each_quality(self):
        from types import SimpleNamespace
        import numpy as np
        source = np.zeros((2, 44100), dtype=np.float32)
        result = SimpleNamespace(acoustic_guitar=source, lead_guitar=source, rhythm_guitar=source)
        with patch("guitar_separator_hq.separator.separate_guitar_arrays", return_value=result) as separate, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(worker.test_guitar_qualities(Path("models"), "cpu"), ["fast", "balanced", "high"])
        self.assertEqual([call.kwargs["quality"] for call in separate.call_args_list], ["fast", "balanced", "high"])
        self.assertTrue(all(call.kwargs["download_missing"] is False for call in separate.call_args_list))


if __name__ == "__main__":
    unittest.main()
