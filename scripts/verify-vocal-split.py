"""Real A/B inference and codec validation; no subjective quality approval.

Run using BandBuddy's managed Python. Inputs are existing vocal stems, never
full mixes. Models must already be downloaded by the development application.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from vocal_separator.separator import separate, verify_encoded


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', action='append', required=True, help='Saved vocal stem; repeat for a corpus')
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda', 'mps'], default='cpu')
    args = parser.parse_args()
    root = Path(args.output).resolve(); root.mkdir(parents=True, exist_ok=True)
    results = []
    for index, source in enumerate(args.input):
        case = root / f'case-{index+1:02d}'; case.mkdir(exist_ok=True)
        decoded = case / 'vocals.wav'
        subprocess.run([args.ffmpeg, '-y', '-v', 'error', '-i', source, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le', str(decoded)], check=True)
        for model in ('mel-karaoke-aufr33-viperx', 'bs-karaoke-frazer-becruily'):
            destination = case / model
            result = separate(decoded, destination, Path(args.model_root), model, args.device)
            peak = max(value['peak'] for value in result['stats'].values())
            checks = {}
            for codec, extension, options, ceiling in (
                ('flac24', 'flac', ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], .999),
                ('mp3_320', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '320k'], .95),
            ):
                gain = min(1, ceiling / max(peak, 1e-20))
                files = []
                for stem in ('lead_vocals', 'backing_vocals'):
                    encoded = destination / f'{stem}.{extension}'
                    subprocess.run([args.ffmpeg, '-y', '-v', 'error', '-i', result['files'][stem], '-af', f'volume={gain:.12f},apad=whole_len={result["frames"]},atrim=end_sample={result["frames"]}', *options, str(encoded)], check=True)
                    decoded_stem = destination / f'{stem}.{extension}.decoded.wav'
                    subprocess.run([args.ffmpeg, '-y', '-v', 'error', '-i', str(encoded), '-c:a', 'pcm_f32le', str(decoded_stem)], check=True)
                    files.append(decoded_stem)
                checks[codec] = {'encodingGain': gain, **verify_encoded(decoded, *files, gain, codec)}
                for file in files:
                    file.unlink()
            result['encodedVerification'] = checks
            results.append({'case': index+1, **result})
            (root / 'results.json').write_text(json.dumps({'subjectiveQualityAccepted': False, 'results': results}, indent=2), encoding='utf-8')
            print(json.dumps({'case': index+1, 'model': model, 'seconds': result['seconds'], 'peakCudaBytes': result['peakCudaBytes'], 'codecs': checks}), flush=True)
    print('Engineering checks passed. Blind listening and redistribution approval remain separate.')


if __name__ == '__main__':
    main()
