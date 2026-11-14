"""Measure candidate size/compute and test a tiny distillation training step.

This is a feasibility test, NOT a trained small separator or quality evaluation.
Only native torch and the existing application modules are used.
"""
import gc
import json
from pathlib import Path
import statistics
import sys
import time
import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import yaml
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"python"))
from guitar_separator_hq._vendor.msst import BSRoformer
from guitar_separator_hq.roformer_core import _checkpoint_state
from vocal_separator.separator import model_spec


def spectral_loss(predicted,target):
    losses=[]
    for n in (512,1024,2048):
        w=torch.hann_window(n,device=predicted.device)
        a=torch.stft(predicted.flatten(0,1).float(),n,n//4,window=w,return_complex=True)
        b=torch.stft(target.flatten(0,1).float(),n,n//4,window=w,return_complex=True)
        # Preserve complex phase and gain; normalize with a floor for quiet stems.
        scale=b.abs().mean().detach().clamp_min(.02)
        losses.append((a-b).abs().mean()/scale)
    return sum(losses)/len(losses)


def main():
    torch.manual_seed(42); torch.set_num_threads(8)
    cfg=yaml.load((ROOT/"python/vocal_separator/configs/config_karaoke_frazer_becruily.yaml").read_text(),Loader=yaml.FullLoader)["model"]
    spec=model_spec("bs-karaoke-frazer-becruily")
    weights=_checkpoint_state(Path.home()/"AppData/Local/BandBuddy/envs/models/vocal-split-v1"/spec["id"]/spec["filename"])
    folder=ROOT/"output/becruily-20261114"
    source,_=sf.read(ROOT/"output/singer-informed-20261114/source/vocals.wav",start=68*44100,frames=4*44100,dtype="float32",always_2d=True)
    pseudo,_=sf.read(folder/"stages/lead_vocals.wav",start=68*44100,frames=4*44100,dtype="float32",always_2d=True)
    x=torch.from_numpy(source.T.copy())[None].cuda()
    target=torch.from_numpy(pseudo.T.copy())[None].cuda()
    candidates={
        "teacher":{},
        "desktop-depth6":{"depth":6},
        "mobile-depth6-d128":{"depth":6,"dim":128,"heads":4,"dim_head":32,"mlp_expansion_factor":2},
        "mobile-depth4-d128":{"depth":4,"dim":128,"heads":4,"dim_head":32,"mlp_expansion_factor":2},
        "mobile-depth4-d96":{"depth":4,"dim":96,"heads":3,"dim_head":32,"mlp_expansion_factor":2},
    }
    report={"trainingQualityValidated":False,"audioSeconds":4,"batch":1,"results":[]}
    for name,changes in candidates.items():
        model=BSRoformer(**{**cfg,**changes})
        if name=="teacher":
            model.load_state_dict(weights,strict=True)
        elif name=="desktop-depth6":
            mapped={}
            for key in model.state_dict():
                if key.startswith("layers."):
                    _,i,rest=key.split(".",2); src=f"layers.{2*int(i)+1}.{rest}"
                else: src=key
                mapped[key]=weights[src]
            model.load_state_dict(mapped,strict=True)
        model.cuda().eval()
        row={"name":name,"config":{**cfg,**changes},"parameters":sum(p.numel() for p in model.parameters()),
             "parameterGroups":{n:sum(p.numel() for p in m.parameters()) for n,m in model.named_children()},
             "initialization":"teacher" if name=="teacher" else "teacher odd-index blocks" if name=="desktop-depth6" else "random"}
        with torch.inference_mode(),torch.autocast("cuda",dtype=torch.float16):
            model(x); torch.cuda.synchronize()
            times=[]
            for _ in range(5):
                t=time.perf_counter(); model(x); torch.cuda.synchronize(); times.append(time.perf_counter()-t)
        row["forwardSeconds"]=times; row["medianForwardSeconds"]=statistics.median(times)
        if name in ("desktop-depth6","mobile-depth6-d128"):
            model.train(); model.use_torch_checkpoint=True
            opt=torch.optim.AdamW(model.parameters(),lr=1e-4)
            scaler=torch.amp.GradScaler("cuda")
            torch.cuda.reset_peak_memory_stats()
            updates=[]
            for _ in range(3):
                opt.zero_grad(set_to_none=True); t=time.perf_counter()
                with torch.autocast("cuda",dtype=torch.float16): prediction=model(x)[:,0]
                # Teacher labels are cached from the long-context full-song run.
                # Residual complex normalization increases quiet residual weight;
                # duplicate raw waveform residual L1 would add no new objective.
                loss=(F.l1_loss(prediction.float(),target)+spectral_loss(prediction,target)
                      +.5*spectral_loss(x-prediction,x-target))
                scaler.scale(loss).backward(); scaler.unscale_(opt)
                norm=torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
                if not torch.isfinite(loss) or not torch.isfinite(norm): raise RuntimeError("Non-finite training step")
                scaler.step(opt); scaler.update(); torch.cuda.synchronize()
                updates.append({"loss":float(loss.detach()),"gradientNorm":float(norm),"seconds":time.perf_counter()-t})
            row["threeStepSmoke"]=updates; row["trainingPeakCudaBytes"]=torch.cuda.max_memory_allocated()
            del opt,scaler,prediction,loss
        report["results"].append(row)
        (folder/"students.json").write_text(json.dumps(report,indent=2))
        print(json.dumps({k:v for k,v in row.items() if k!="config"}),flush=True)
        del model; gc.collect(); torch.cuda.empty_cache()


if __name__=="__main__": main()
