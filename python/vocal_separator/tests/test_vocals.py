from pathlib import Path
import sys
import tempfile
import unittest
import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from vocal_separator.separator import split_arrays, verify_encoded, model_spec
from guitar_separator_hq.roformer_core import _demix_once


class VocalTests(unittest.TestCase):
    def test_reconstruction_preserves_gain_and_odd_length(self):
        rng = np.random.default_rng(4)
        vocals = rng.normal(0, .2, (2, 77123)).astype(np.float32)
        lead = rng.normal(0, .4, vocals.shape).astype(np.float32)
        main, harmony, error = split_arrays(vocals, lead)
        self.assertEqual(main.shape, vocals.shape)
        self.assertLess(error, 2e-7)
        np.testing.assert_allclose(main + harmony, vocals, atol=2e-7)
        with self.assertRaisesRegex(RuntimeError, 'AUDIO_LENGTH_MISMATCH'):
            split_arrays(vocals, np.zeros((2, 3), np.float32))

    def test_silence_and_nonfinite(self):
        zero = np.zeros((2, 441), np.float32)
        _, harmony, error = split_arrays(zero, zero)
        self.assertEqual(error, 0)
        self.assertFalse(harmony.any())
        invalid = zero.copy(); invalid[0, 0] = np.nan
        with self.assertRaises((ValueError, RuntimeError)):
            split_arrays(zero, invalid)

    def test_batch_inference_matches_original_single_chunk_policy(self):
        source = np.random.default_rng(3).normal(0, .1, (2, 7777)).astype(np.float32)
        model = torch.nn.Identity()
        results = [_demix_once(model, source, chunk_size=1024, overlap=4, use_amp=False,
                              device=torch.device('cpu'), progress=None, batch_size=batch) for batch in (1, 2, 3)]
        for result in results:
            np.testing.assert_allclose(result, source, atol=1e-7)
        np.testing.assert_array_equal(results[0], results[1])
        with self.assertRaises(ValueError):
            _demix_once(model, source, chunk_size=1024, overlap=4, use_amp=False,
                        device=torch.device('cpu'), progress=None, batch_size=0)

    def test_lossless_encoding_reconstruction_and_frame_guard(self):
        with tempfile.TemporaryDirectory() as root:
            v, l, b = [Path(root) / f'{name}.wav' for name in ('vocals', 'lead', 'backing')]
            source = np.random.default_rng(9).normal(0, .1, (44117, 2)).astype(np.float32)
            lead = source * 2.1
            gain = .7
            sf.write(v, source, 44100, subtype='FLOAT')
            sf.write(l, lead * gain, 44100, subtype='PCM_24')
            sf.write(b, (source - lead) * gain, 44100, subtype='PCM_24')
            result = verify_encoded(v, l, b, gain, 'flac24')
            self.assertEqual(result['frames'], len(source))
            self.assertLess(result['reconstructionMaxError'], 1e-6)
            sf.write(b, source[:-1], 44100, subtype='FLOAT')
            with self.assertRaisesRegex(RuntimeError, 'FRAME_MISMATCH'):
                verify_encoded(v, l, b, gain, 'mp3_320')

    def test_catalog_uses_distinct_pinned_configs(self):
        mel = model_spec('mel-karaoke-aufr33-viperx')
        bs = model_spec('bs-karaoke-frazer-becruily')
        self.assertNotEqual(mel['configSha256'], bs['configSha256'])
        self.assertEqual(mel['architecture'], 'mel_band_roformer')
        self.assertEqual(bs['architecture'], 'bs_roformer')


if __name__ == '__main__':
    unittest.main()
