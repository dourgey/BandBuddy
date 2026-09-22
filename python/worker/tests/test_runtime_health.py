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
                "schema": 1, "checkedAt": time.time(), "versions": {key: "test" for key in packages},
                "result": {"modelReady": True, "dependenciesReady": True, "cudaAvailable": False},
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
