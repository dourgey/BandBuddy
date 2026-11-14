from pathlib import Path
import math
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from beat_this_tempo import summarize_beats


class BeatThisTempoTests(unittest.TestCase):
    def test_decimal_tempos_and_phase_despite_frame_quantization(self):
        for bpm in (45, 73.2, 96, 120, 123.4, 180, 240):
            with self.subTest(bpm=bpm):
                beats = [round((0.137 + i * 60 / bpm) * 50) / 50 for i in range(160)]
                result = summarize_beats(beats)
                self.assertAlmostEqual(result['bpm'], bpm, delta=0.1)
                period_ms = 60000 / result['bpm']
                error = (result['beatOffsetMs'] - 137 + period_ms / 2) % period_ms - period_ms / 2
                self.assertLess(abs(error), 15)
                self.assertGreater(result['confidence'], 0.9)

    def test_missing_beats_do_not_halve_the_tempo(self):
        beats = [0.14 + i * 0.5 for i in range(100) if i % 13 != 0]
        result = summarize_beats(beats)
        self.assertEqual(result['bpm'], 120)
        self.assertAlmostEqual(result['beatOffsetMs'], 140, delta=1)

    def test_rejects_invalid_or_too_short_predictions(self):
        for beats in ([], [0, 0.5], [0.5] * 20, [1, 0] * 10,
                      [math.nan] * 20, [math.inf] * 20, [-0.5 + i / 2 for i in range(30)]):
            self.assertIsNone(summarize_beats(beats))

    def test_variable_tempo_reduces_fixed_grid_confidence(self):
        times = [0.137]
        for i in range(159):
            times.append(times[-1] + 0.47 + 0.06 * i / 159)
        result = summarize_beats(times)
        self.assertIsNotNone(result)
        self.assertLess(result['confidence'], 0.8)

    def test_random_intervals_do_not_create_a_stable_prediction(self):
        rng = random.Random(42)
        times = [0.1]
        for _ in range(100):
            times.append(times[-1] + rng.uniform(0.2, 1.5))
        self.assertIsNone(summarize_beats(times))


if __name__ == '__main__':
    unittest.main()
