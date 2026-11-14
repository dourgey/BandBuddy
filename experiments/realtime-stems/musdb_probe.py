"""Score streaming presets against independent MUSDB18 test stems."""
import json
import subprocess

import numpy as np

from probe import DATA, PROFILES, RATE, ROOT, estimate, metrics, model_for, render


def decode(path, index):
    raw = subprocess.check_output([ROOT / "resources/bin/ffmpeg.exe", "-loglevel", "error",
                                   "-i", path, "-map", f"0:a:{index}", "-ar", str(RATE),
                                   "-ac", "2", "-f", "f32le", "pipe:1"])
    return np.frombuffer(raw, "<f4").reshape(-1, 2)


def main():
    rows = {}
    model = model_for("cuda")
    for path in sorted((DATA / "musdb-test").glob("*.stem.mp4")):
        tracks = [decode(path, i) for i in range(1, 5)]
        length = min(map(len, tracks))
        drums, bass, other, vocals = [x[:length] for x in tracks]
        bed = bass + other + vocals
        mix = bed + drums
        model.use_train_segment = True
        row = {"offline": metrics(mix - estimate(model, mix, "drums"), bed, drums)}
        model.use_train_segment = False
        for profile in PROFILES:
            out, _ = render(model, profile, mix)
            row[profile] = metrics(out, bed, drums)
        rows[path.name] = row
        print(path.name, round(row["balanced"]["error_improvement_db"], 1), flush=True)
    if not rows:
        raise FileNotFoundError("Place MUSDB18 test excerpts under output/realtime-stems/musdb-test")
    summary = {}
    for profile in ("offline", *PROFILES):
        summary[profile] = {k: round(float(np.median([r[profile][k] for r in rows.values()])), 2)
                            for k in next(iter(rows.values()))[profile]}
    (DATA / "musdb.json").write_text(json.dumps({"medians": summary, "tracks": rows}, indent=2),
                                     encoding="utf8")
    print(summary)


if __name__ == "__main__":
    main()
