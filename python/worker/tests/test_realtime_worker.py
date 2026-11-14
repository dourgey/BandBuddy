import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import queue
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from realtime_worker import combine, evaluate, probe_signal, verify_probe, STEMS, Separator, DriftController, run


class RealtimeWorkerTests(unittest.TestCase):
    def test_clock_drift_remains_bounded_for_fifteen_minutes(self):
        for rate in (44100, 48000):
            for hop in (.06, .12):
                frames = round(rate * hop)
                for ppm in (-1000, 0, 1000):
                    controller = DriftController(rate)
                    depth = rate * .04
                    for _ in range(round(900 / hop)):
                        correction = controller.adjustment(depth, frames)
                        depth += correction - frames * ppm / 1e6
                        self.assertGreater(depth, rate * .02)
                        self.assertLess(depth, rate * .06)
                        self.assertLessEqual(abs(correction), frames * .002 + 1)

    def test_multi_selection_uses_same_estimates(self):
        estimates = np.arange(1, 7, dtype=np.float32)[:, None, None] * np.ones((6, 32, 2), np.float32)
        mix = estimates.sum(axis=0)
        selected = ['drums', 'vocals']
        np.testing.assert_array_equal(combine(mix, estimates, list(STEMS), selected, 'solo'), np.full((32, 2), 5))
        np.testing.assert_array_equal(combine(mix, estimates, list(STEMS), selected, 'remove'), np.full((32, 2), 16))
        np.testing.assert_array_equal(combine(mix, estimates, list(STEMS), list(STEMS), 'remove'), np.zeros_like(mix))
        np.testing.assert_array_equal(combine(mix, estimates, list(STEMS), list(STEMS), 'solo'), mix)
        for index, name in enumerate(STEMS):
            np.testing.assert_array_equal(combine(mix, estimates, list(STEMS), [name], 'solo'), estimates[index])
            np.testing.assert_array_equal(combine(mix, estimates, list(STEMS), [name], 'remove'), mix - estimates[index])

    def test_mode_changes_crossfade_before_exact_all_stem_output(self):
        import torch
        separator = Separator.__new__(Separator)
        separator.torch, separator.device = torch, 'cpu'
        class Model:
            sources = list(STEMS)
            def __call__(self, x):
                return torch.zeros((1, 6, 2, x.shape[-1]))
        separator.model = Model()
        separator.past, separator.hop, separator.future = 4, 8, 4
        separator.window = np.ones((16, 2), np.float32)
        separator.fade = np.array([[0], [1]], np.float32)
        separator.previous, separator.selection = None, None
        data = np.ones((8, 2), np.float32)
        np.testing.assert_array_equal(separator.step(data, list(STEMS), 'solo'), data)
        faded = separator.step(data, list(STEMS), 'remove')
        np.testing.assert_array_equal(faded[0], [1, 1])
        np.testing.assert_array_equal(faded[1:], np.zeros((7, 2)))
        np.testing.assert_array_equal(separator.step(data, list(STEMS), 'remove'), np.zeros((8, 2)))
        faded = separator.step(data, list(STEMS), 'solo')
        np.testing.assert_array_equal(faded[0], [0, 0])
        np.testing.assert_array_equal(faded[1:], np.ones((7, 2)))

    def test_device_or_permission_failure_always_closes_opened_native_session(self):
        class NativeFailure:
            closed = False
            def command(self, op, config=None):
                if op == 'bb_stats':
                    raise RuntimeError('DEVICE_OR_PERMISSION_LOST')
            def close(self):
                self.closed = True
        separator = SimpleNamespace(window=np.zeros((8, 2)), previous=None)
        for message in ('DEVICE_OR_PERMISSION_LOST',):
            native = NativeFailure()
            with patch('realtime_worker.Separator', return_value=separator), patch('realtime_worker.time.monotonic', side_effect=[0, 6, 7, 8]), patch('realtime_worker.emit'):
                with self.assertRaisesRegex(RuntimeError, message):
                    run(SimpleNamespace(model_root='', device='cpu', test=False), native,
                        dict(profile='smooth', stems=['drums'], mode='remove', rate=48000, source='virtual', output='speakers'), queue.Queue())
            self.assertTrue(native.closed)

    def test_probe_detects_route_not_silence_or_unrelated_audio(self):
        for rate in (44100, 48000):
            signal = np.roll(probe_signal(rate), 239)
            self.assertGreater(verify_probe(np.column_stack((signal, signal)), rate), .99)
            self.assertEqual(verify_probe(np.zeros((rate, 2)), rate), 0)
            self.assertLess(verify_probe(np.random.default_rng(9).normal(0, .01, (rate, 2)), rate), .1)

    def test_gate_rejects_deadline_failures_and_unknown_clocks(self):
        stats = dict(inputDrops=0, underruns=0, overflows=0, clockErrors=0, maxLatencyMs=450)
        self.assertTrue(evaluate(stats, stats, [40] * 500, 'smooth', True)['passed'])
        self.assertFalse(evaluate(stats, stats, [40] * 500, 'lowLatency', True)['passed'])
        for field in ('inputDrops', 'underruns', 'overflows', 'clockErrors'):
            self.assertFalse(evaluate({**stats, field: 1}, stats, [40] * 500, 'smooth', True)['passed'])
        self.assertFalse(evaluate(stats, stats, [40] * 499 + [121], 'smooth', True)['passed'])
        self.assertFalse(evaluate(stats, stats, [97] * 500, 'smooth', True)['passed'])
        self.assertFalse(evaluate(stats, stats, [40], 'smooth', False)['passed'])
        self.assertFalse(evaluate(stats, stats, [], 'smooth', True)['passed'])


if __name__ == '__main__':
    unittest.main()
