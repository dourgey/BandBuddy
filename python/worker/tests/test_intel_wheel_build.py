import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("intel_wheel_build", ROOT / "scripts/build-intel-runtime-wheel.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class IntelWheelBuildTests(unittest.TestCase):
    def wheel(self, path, name="scipy", version="1.17.0"):
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(f"{name}-{version}.dist-info/METADATA", f"Name: {name}\nVersion: {version}\n")

    def test_platform_tags_require_intel_and_macos13_or_earlier(self):
        for tag in ("macosx_10_14_x86_64", "macosx_13_0_x86_64", "macosx_11_0_universal2", "any"):
            self.assertTrue(builder.supports_macos13(f"package-1-cp312-cp312-{tag}.whl"))
        for tag in ("macosx_14_0_x86_64", "macosx_13_1_x86_64", "macosx_11_0_arm64", "manylinux_2_17_x86_64"):
            self.assertFalse(builder.supports_macos13(f"package-1-cp312-cp312-{tag}.whl"))

    def test_new_runner_wheel_is_replaced_only_using_original_hash_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            output.mkdir()
            old = output / "scipy-1.17.0-cp312-cp312-macosx_14_0_x86_64.whl"
            self.wheel(old)
            lock = root / "runtime.lock"
            requirement = "scipy==1.17.0 \\\n    --hash=sha256:" + "a" * 64 + "\n"
            lock.write_text(requirement)

            def download(args, **kwargs):
                self.assertIn("--require-hashes", args)
                self.assertIn("--only-binary=:all:", args)
                self.assertEqual(args[args.index("--platform") + 1], "macosx_13_0_x86_64")
                selected_requirement = Path(args[args.index("--requirement") + 1]).read_text()
                self.assertIn("scipy==1.17.0", selected_requirement)
                self.assertIn("--hash=sha256:" + "a" * 64, selected_requirement)
                target = Path(args[args.index("--dest") + 1])
                self.wheel(target / "scipy-1.17.0-cp312-cp312-macosx_10_14_x86_64.whl")

            with patch.object(builder, "run", side_effect=download):
                builder.ensure_deployment_wheels(output, lock, Path("python"), root, {})
            self.assertFalse(old.exists())
            self.assertTrue((output / "scipy-1.17.0-cp312-cp312-macosx_10_14_x86_64.whl").is_file())

    def test_missing_hash_cannot_trigger_unpinned_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "scipy-1.17.0-cp312-cp312-macosx_14_0_x86_64.whl"
            self.wheel(old)
            lock = root / "runtime.lock"
            lock.write_text("scipy==1.17.0\n")
            with patch.object(builder, "run") as run, self.assertRaisesRegex(RuntimeError, "DEPLOYMENT_TARGET_INVALID"):
                builder.ensure_deployment_wheels(root, lock, Path("python"), root, {})
            run.assert_not_called()
            self.assertTrue(old.exists())


if __name__ == "__main__":
    unittest.main()
