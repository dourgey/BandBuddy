"""Stage audit using the native managed runtime; no environment modifications.

CUDA events measure module intervals (including host launch gaps), not FLOPs.
The outer stage timer synchronizes at stage boundaries for attribution.
"""
import time
START = time.perf_counter()
import argparse
from collections import defaultdict
from contextlib import contextmanager
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import yaml
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from guitar_separator_hq._vendor.msst import BSRoformer
from guitar_separator_hq.roformer_core import _checkpoint_state, _linear_window
from guitar_separator_hq import memory
from vocal_separator.separator import digest, model_spec, split_arrays, verify_encoded
IMPORT_SECONDS = time.perf_counter()-START


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=ROOT/"output/singer-informed-20261114/source/vocals.wav")
    parser.add_argument("--output", type=Path, default=ROOT/"output/becruily-20261114/stages")
    parser.add_argument("--overlap", type=int, default=4)
    parser.add_argument("--seconds", type=float)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(8)
    stages = defaultdict(float)
    @contextmanager
    def stage(name, sync=False):
        if sync: torch.cuda.synchronize()
        start = time.perf_counter()
        yield
        if sync: torch.cuda.synchronize()
        stages[name] += time.perf_counter()-start
    spec = model_spec("bs-karaoke-frazer-becruily")
    ckpt = Path.home()/"AppData/Local/BandBuddy/envs/models/vocal-split-v1"/spec["id"]/spec["filename"]
    cfgpath = ROOT/"python/vocal_separator/configs"/spec["config"]
    with stage("hash_and_config"):
        assert digest(ckpt)==spec["sha256"] and digest(cfgpath)==spec["configSha256"]
        config = yaml.load(cfgpath.read_text(), Loader=yaml.FullLoader)
    with stage("audio_read"):
        audio, sr = sf.read(args.input, dtype="float32", always_2d=True)
        if args.seconds: audio=audio[:round(sr*args.seconds)]
        audio=audio.T.copy()
    with stage("model_construct"):
        model = BSRoformer(**config["model"])
    with stage("checkpoint_read_and_load"):
        model.load_state_dict(_checkpoint_state(ckpt), strict=True)
        model.eval().requires_grad_(False)
    with stage("cuda_init_and_upload"):
        model.cuda()
        torch.cuda.synchronize()
    events=defaultdict(list)
    def hooks(module, name):
        def before(mod, inp):
            e=torch.cuda.Event(enable_timing=True); e.record(); mod._audit_event=e
        def after(mod, inp, out):
            e=torch.cuda.Event(enable_timing=True); e.record(); events[name].append((mod._audit_event,e))
        module.register_forward_pre_hook(before); module.register_forward_hook(after)
    hooks(model.band_split,"band_split")
    hooks(model.final_norm,"final_norm")
    hooks(model.mask_estimators[0],"mask_estimator")
    for block in model.layers:
        hooks(block[0],"time_transformer")
        hooks(block[1],"frequency_transformer")
        for name, transformer in (("time",block[0]),("frequency",block[1])):
            for attention, ff in transformer.layers:
                hooks(attention,name+"_attention")
                hooks(ff,name+"_feed_forward")
                hooks(attention.attend,name+"_sdpa")
    # STFT wrappers use exactly the same functions and inputs as the model.
    saved={}
    for name in ("stft","istft"):
        saved[name]=getattr(torch,name)
        def timed(*a,_name=name,**kw):
            s=torch.cuda.Event(enable_timing=True); e=torch.cuda.Event(enable_timing=True)
            s.record(); out=saved[_name](*a,**kw); e.record(); events[_name].append((s,e)); return out
        setattr(torch,name,timed)
    chunk=882000; overlap=args.overlap; batch=2; step=chunk//overlap; border=chunk-step
    frames=audio.shape[-1]
    with stage("prepare_buffers"):
        padded=torch.from_numpy(audio)
        used=frames>2*border and border>0
        if used: padded=F.pad(padded,(border,border),mode="reflect")
        window=_linear_window(chunk)
        result=torch.from_numpy(memory.zeros((1,2,padded.shape[-1])))
        counter=torch.from_numpy(memory.zeros(padded.shape[-1]))
        starts=list(range(0,padded.shape[-1],step))
    torch.cuda.reset_peak_memory_stats()
    demix_start=time.perf_counter()
    with torch.inference_mode():
        for gi in range(0,len(starts),batch):
            with stage("cpu_chunk_pack"):
                parts=[]; lengths=[]
                for start in starts[gi:gi+batch]:
                    part=padded[:,start:start+chunk]; n=part.shape[-1]
                    if n<chunk: part=F.pad(part,(0,chunk-n),mode="reflect" if n>chunk//2 else "constant")
                    parts.append(part); lengths.append(n)
                tensor=torch.stack(parts)
            with stage("host_to_gpu",True): tensor=tensor.cuda()
            with stage("model_forward",True):
                with torch.autocast("cuda",dtype=torch.float16): predicted=model(tensor)
            with stage("gpu_to_host",True): predicted=predicted.float().cpu()
            with stage("cpu_overlap_add"):
                for j,(start,n) in enumerate(zip(starts[gi:gi+batch],lengths)):
                    w=window.clone(); index=gi+j
                    if index==0: w[:chunk//10]=1.
                    if index==len(starts)-1: w[-chunk//10:]=1.
                    result[...,start:start+n]+=predicted[j,:,:,:n]*w[:n]
                    counter[start:start+n]+=w[:n]
    with stage("normalize_and_crop"):
        lead=memory.divide_in_place(result.numpy(),counter.numpy()[None,None])
        if used: lead=lead[...,border:-border]
        lead=memory.contiguous(lead[0,:,:frames])
    demix_seconds=time.perf_counter()-demix_start
    with stage("residual_and_validation"):
        lead,residual,error=split_arrays(audio,lead)
    with stage("write_float_wav"):
        for name,value in (("lead_vocals",lead),("backing_vocals",residual)):
            sf.write(args.output/(name+".wav"),value.T,sr,subtype="FLOAT")
    gain=min(1,.95/max(float(np.max(np.abs(lead))),float(np.max(np.abs(residual))),1e-20))
    with stage("encode_two_flac24"):
        for name in ("lead_vocals","backing_vocals"):
            subprocess.run([str(ROOT/"resources/bin/ffmpeg.exe"),"-y","-v","error","-i",str(args.output/(name+".wav")),"-af",f"volume={gain:.12f}","-c:a","flac","-sample_fmt","s32","-bits_per_raw_sample","24",str(args.output/(name+".flac"))],check=True)
    if args.seconds:
        source=args.output/"input.wav"; sf.write(source,audio.T,sr,subtype="FLOAT")
    else: source=args.input
    with stage("verify_flac_pair"):
        verified=verify_encoded(source,args.output/"lead_vocals.flac",args.output/"backing_vocals.flac",gain,"flac24")
    torch.cuda.synchronize()
    timings={name:sum(s.elapsed_time(e) for s,e in pairs)/1000 for name,pairs in events.items()}
    report=dict(input=str(args.input),durationSeconds=frames/sr,chunkSeconds=20,overlap=overlap,batch=2,
                modelWindows=len(starts),paddedSeconds=padded.shape[-1]/sr,importSeconds=IMPORT_SECONDS,
                stages=dict(stages),modelCudaIntervals=timings,demixSeconds=demix_seconds,
                processElapsedToVerification=time.perf_counter()-START,peakCudaBytes=torch.cuda.max_memory_allocated(),
                reconstructionMaxError=error,encodingGain=gain,verification=verified,
                note="Nested CUDA intervals must not be added twice. CUDA intervals include host dispatch gaps. Disk cache not flushed; first inference, no warmup. UI/database/peaks not profiled.")
    (args.output/"profile.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2),flush=True)


if __name__=="__main__": main()
