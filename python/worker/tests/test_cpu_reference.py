from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cpu_reference as reference


class CpuReferenceTests(unittest.TestCase):
    def arrays(self):
        source = reference.fixed_input()
        return {name: source.copy() for name in reference.policy()["tracks"]}

    def test_integer_input_and_model_manifest_match_release_gate_anchors(self):
        self.assertEqual(reference.sha256(reference.fixed_input().tobytes()), "93dfefe3a63fdf0bda67ef8054463cfd6b71e29eb50a1c234b010f94eb1944e9")
        self.assertEqual(reference.sha256(reference.canonical(reference.model_manifest())), "cf7ccc0ca97c332a3eb82f92e47b8a1ddb30995ff344e88fd0044e83bd2ca4d9")

    def test_identity_reports_all_fifteen_tracks_with_exact_pcm_hashes(self):
        arrays = self.arrays()
        report = reference.compare_outputs(arrays, arrays)
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["tracks"]), 15)
        for result in report["tracks"].values():
            self.assertEqual((result["maxAbs"], result["rmse"], result["relativeL2"]), (0, 0, 0))
            self.assertEqual(result["actualPcmSha256"], result["referencePcmSha256"])

    def test_numeric_failure_is_retained_with_fixed_thresholds(self):
        baseline = self.arrays()
        candidate = {key: value.copy() for key, value in baseline.items()}
        candidate["high/lead_guitar"] += np.float32(0.001)
        report = reference.compare_outputs(baseline, candidate)
        self.assertFalse(report["passed"])
        self.assertFalse(report["tracks"]["high/lead_guitar"]["passed"])
        self.assertGreater(report["tracks"]["high/lead_guitar"]["maxAbs"], report["thresholds"]["maxAbs"])
        self.assertEqual(report["thresholds"], {"maxAbs": 1e-4, "rmse": 1e-5, "relativeL2": 1e-3})

    def test_missing_and_nonfinite_outputs_cannot_qualify(self):
        baseline = self.arrays()
        candidate = {key: value.copy() for key, value in baseline.items()}
        candidate.pop("fast/acoustic_guitar")
        with self.assertRaisesRegex(RuntimeError, "TRACKS_INCOMPLETE"):
            reference.compare_outputs(baseline, candidate)
        candidate = {key: value.copy() for key, value in baseline.items()}
        candidate["six_stem/vocals"][0, 0] = np.nan
        with self.assertRaisesRegex(RuntimeError, "OUTPUT_INVALID"):
            reference.compare_outputs(baseline, candidate)

    def test_archive_round_trip_binds_actual_bytes_and_production_code(self):
        # Synthetic arrays are test fixtures only; this cannot create a production pin.
        environment = {"device": "cpu", "platform": "Darwin", "architecture": "arm64", "packages": reference.policy()["referencePackages"]}
        with tempfile.TemporaryDirectory() as directory, patch.object(reference, "environment", return_value=environment):
            target = Path(directory, "reference.zip")
            pin = reference.export_reference(target, self.arrays())
            metadata, arrays = reference.read_reference(target, pin)
            self.assertEqual(metadata["tracks"], reference.policy()["tracks"])
            self.assertEqual(len(arrays), 15)
            with self.assertRaisesRegex(RuntimeError, "REFERENCE_EXISTS"):
                reference.export_reference(target, self.arrays())
            with patch.object(reference, "production_hash", return_value="0" * 64), self.assertRaisesRegex(RuntimeError, "PROFILE_MISMATCH:productionCodeSha256"):
                reference.read_reference(target, pin)
            with self.assertRaisesRegex(RuntimeError, "PIN_INVALID"):
                reference.read_reference(target, {**pin, "policySha256": "0" * 64})
            target.write_bytes(target.read_bytes() + b"tamper")
            with self.assertRaisesRegex(RuntimeError, "SHA256_MISMATCH"):
                reference.read_reference(target, pin)

    def test_production_digest_excludes_only_test_subtrees_not_repository_ancestors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory, "tests/project")
            contents = {"python/worker/worker.py": "worker", "python/worker/model_download.py": "models",
                        "python/guitar_separator_hq/inference.py": "inference", "python/guitar_separator_hq/tests/test_inference.py": "test"}
            for filename, content in contents.items():
                target = root / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            expected = {filename: reference.sha256(content.encode()) for filename, content in contents.items() if "/tests/" not in filename}
            with patch.object(reference, "ROOT", root):
                self.assertEqual(reference.production_hash(), reference.sha256(reference.canonical(expected)))


if __name__ == "__main__":
    unittest.main()
