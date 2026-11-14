"""Measure the actual fresh-worker verification and media stages separately."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/"output/becruily-20261114/pipeline-io"
OUT.mkdir(parents=True,exist_ok=True)
ffmpeg=str(ROOT/"resources/bin/ffmpeg.exe")
profile=json.loads((OUT.parent/"stages/profile.json").read_text())
times={}
def timed(name,args):
    start=time.perf_counter()
    result=subprocess.run(args,capture_output=True,text=True,encoding="utf-8",errors="replace",env={**os.environ,"PYTHONIOENCODING":"utf-8","BANDBUDDY_CPU_THREADS":"8"})
    times[name]={"seconds":time.perf_counter()-start,"exitCode":result.returncode}
    if result.returncode: raise RuntimeError(result.stderr)
    return result.stdout
timed("decode_saved_vocals",[ffmpeg,"-y","-v","error","-i",profile["input"],"-ar","44100","-ac","2","-c:a","pcm_f32le",str(OUT/"input.wav")])
for stem in ("lead_vocals","backing_vocals"):
    timed("decode_"+stem,[ffmpeg,"-y","-v","error","-i",str(OUT.parent/"stages"/(stem+".flac")),"-c:a","pcm_f32le",str(OUT/(stem+".wav"))])
output=timed("fresh_verify_worker",[sys.executable,str(ROOT/"python/worker/worker.py"),"verify-vocals","--input",str(OUT/"input.wav"),"--lead",str(OUT/"lead_vocals.wav"),"--backing",str(OUT/"backing_vocals.wav"),"--gain",str(profile["encodingGain"]),"--storage-format","flac24"])
times["fresh_verify_worker"]["output"]=output
times["scope"]="Local saved WAV; source format affects decode time. No GUI/database/peak generation measured. File-system cache not flushed."
(OUT/"results.json").write_text(json.dumps(times,indent=2))
print(json.dumps(times,indent=2))
