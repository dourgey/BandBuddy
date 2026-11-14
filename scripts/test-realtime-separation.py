"""Hardware qualification. Explicitly select source and output endpoints."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python/worker'))
from realtime_worker import Native


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--native', required=True)
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--source-name', required=True)
    parser.add_argument('--output-name', required=True)
    parser.add_argument('--profile', choices=['smooth', 'lowLatency'], default='smooth')
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--rate', type=int, choices=[44100, 48000], default=48000)
    parser.add_argument('--endurance-seconds', type=int, default=0)
    args = parser.parse_args()
    devices = Native(args.native).command('bb_devices')
    def find(name, direction):
        matches = [d for d in devices if name.lower() in d['name'].lower() and d[direction]]
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one {direction} device matching {name}')
        return matches[0]['id']
    config = {'source': find(args.source_name, 'input'), 'output': find(args.output_name, 'output'),
              'rate': args.rate, 'profile': args.profile, 'stems': ['drums', 'vocals'], 'mode': 'remove'}
    worker = [sys.executable, str(ROOT/'python/worker/realtime_worker.py'), '--native', str(Path(args.native).resolve())]
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1', 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4'}
    generator = None
    if args.endurance_seconds:
        probe = {**config, 'source': 'probe', 'output': config['source'], 'probeOnly': True}
        generator = subprocess.Popen(worker + ['--probe', '--config', json.dumps(probe)], env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
    child = subprocess.Popen(worker + ['--model-root', args.model_root, '--device', args.device, '--config', json.dumps(config)]
                             + ([] if args.endurance_seconds else ['--test']), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, encoding='utf8')
    timer = None
    def stop():
        if child.poll() is None:
            child.stdin.write('{"op":"stop"}\n'); child.stdin.flush()
    last_metrics = None
    started = None
    checkpoint = 0
    try:
        for line in child.stdout:
            event = json.loads(line)
            if event['type'] == 'metrics':
                last_metrics = event['metrics']
                if started and time.monotonic() - started >= checkpoint + 60:
                    checkpoint = int(time.monotonic() - started)
                    print(json.dumps({'runningSeconds': checkpoint, 'metrics': last_metrics}), flush=True)
            else:
                print(line, end='', flush=True)
            if args.endurance_seconds and event.get('phase') == 'running' and timer is None:
                started = time.monotonic()
                timer = threading.Timer(args.endurance_seconds, stop); timer.start()
        code = child.wait(timeout=10)
        print(json.dumps({'exitCode': code, 'runningSeconds': time.monotonic()-started if started else 0, 'lastMetrics': last_metrics}), flush=True)
        return code
    finally:
        if timer: timer.cancel()
        if child.poll() is None: child.kill(); child.wait()
        if generator:
            generator.stdin.close()
            try:
                generator.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(generator.pid), '/T', '/F'], capture_output=True)
                else:
                    generator.kill()
                generator.wait()


if __name__ == '__main__':
    sys.exit(main())
