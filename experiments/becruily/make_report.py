"""Summarize measured data and create same-gain overlap listening clips."""
import html
import json
from pathlib import Path
import sys
from urllib.parse import quote
import numpy as np
import soundfile as sf
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"python"))
from vocal_separator.separator import verify_encoded
OUT=ROOT/"output/becruily-20261114"
profile=json.loads((OUT/"stages/profile.json").read_text())
full=json.loads((OUT/"full/benchmark.json").read_text())
students=json.loads((OUT/"students.json").read_text())
io=json.loads((OUT/"pipeline-io/results.json").read_text())
baseline=full["results"][0]["medianSeconds"]
variants=["baseline-b2-t8","overlap3-b2","overlap2-b2"]
rows={row["name"]:row for row in full["results"]}
lead0,_=sf.read(OUT/"full/baseline-b2-t8/lead_vocals.wav",dtype="float32")
profiled,_=sf.read(OUT/"stages/lead_vocals.wav",dtype="float32")
parity=float(np.max(np.abs(lead0-profiled)))
assert parity<1e-6,parity
lines=["# becruily：本机实测结果", "", "2026-11-14；RTX 3060 Laptop 6GB，现有 PyTorch 2.11.0+cu130；未安装或更换依赖。", "",
       "输入：《珊瑚海》的全部人声，255.467 秒。下表仅主唱/和声细分推理，不含上游人声提取和编码。整曲每配置单次，短片段重复三次；小幅差距受到温度影响。", "",
       "|设置|整曲推理秒数|相对速度|相对原版差分 SNR|", "|---|---:|---:|---:|"]
for name in variants:
    row=rows[name]
    lines.append(f'|20秒窗 / {row["overlap"]}重叠 / batch2|{row["medianSeconds"]:.2f}|{baseline/row["medianSeconds"]:.2f}×|'+("基准" if name==variants[0] else f'{row["referenceDifferenceSnrDb"]:.2f}dB')+"|")
lines += ["", "差分 SNR 不是分离 SDR，没有原始独立录音轨；降低重叠会改变输出，不能据此认定音质通过。", "", "## 阶段耗时", "", "|阶段|秒|", "|---|---:|", f'|依赖导入|{profile["importSeconds"]:.3f}|']
for name,value in profile["stages"].items(): lines.append(f"|{name}|{value:.3f}|")
lines += ["", "## 模型内部", "", "CUDA event 区间包含主机调度间隙；SDPA 和 FFN 属于 Transformer 子区间，不能重复求和。", "", "|区间|秒|", "|---|---:|"]
for name,value in profile["modelCudaIntervals"].items(): lines.append(f"|{name}|{value:.3f}|")
lines += ["", "## 独立应用阶段复现", "", "|阶段|秒|", "|---|---:|"]
for name,value in io.items():
    if isinstance(value,dict): lines.append(f'|{name}|{value["seconds"]:.3f}|')
lines += ["", "此处 fresh_verify_worker 包含一次新的 Python/torch 导入，不能与同进程校验混为一谈。未测 GUI、数据库、峰值图或网络下载。", "", "## 小模型可运行性", "", "速度为同一 GPU、batch1、4秒音频、FP16、五次中位数；小学生未完成训练。", "", "|结构|参数M|FP16参数MB|前向ms|", "|---|---:|---:|---:|"]
for row in students["results"]:
    lines.append(f'|{row["name"]}|{row["parameters"]/1e6:.2f}|{row["parameters"]*2/1e6:.2f}|{row["medianForwardSeconds"]*1000:.1f}|')
lines += ["", "只做了少量反向更新，不能当作蒸馏音质成绩；未导出可用小模型。详细训练、数据、损失与移动部署方案见项目 experiments/becruily/README.md。", "",f"阶段剖析实现与原版推理整曲输出最大误差：{parity:.3g}。", ""]

clips=OUT/"listening"; clips.mkdir(exist_ok=True)
audio,sr=sf.read(profile["input"],dtype="float32",always_2d=True)
gain=.9  # One fixed gain across input, baselines and candidates; not per-file normalization.
assert np.max(np.abs(audio))*gain<1
checks=[]
cards=[]
for tag,start in (("01",68),("02",205)):
    n=25*sr; begin=start*sr
    source=audio[begin:begin+n]
    source_path=clips/f"{tag}-input.wav"; sf.write(source_path,source,sr,subtype="FLOAT")
    sf.write(clips/f"{tag}-input.flac",source*gain,sr,subtype="PCM_24")
    def player(label,path):
        return f'<label>{html.escape(label)}<audio controls preload="none" src="{quote(path)}"></audio></label>'
    cards.append(f'<h2>{start//60:02d}:{start%60:02d}–{(start+25)//60:02d}:{(start+25)%60:02d}</h2><div class="grid">')
    cards.append(player("输入全部人声",f"listening/{tag}-input.flac"))
    for variant in variants:
        for stem in ("lead_vocals","backing_vocals"):
            value,_=sf.read(OUT/"full"/variant/(stem+".wav"),start=begin,frames=n,dtype="float32",always_2d=True)
            assert np.max(np.abs(value))*gain<1
            path=clips/f"{tag}-{variant}-{stem}.flac"
            sf.write(path,value*gain,sr,subtype="PCM_24")
            cards.append(player(f'{rows[variant]["overlap"]}重叠 · '+("主唱" if stem=="lead_vocals" else "和声残差"),str(path.relative_to(OUT)).replace("\\","/")))
        check=verify_encoded(source_path,clips/f"{tag}-{variant}-lead_vocals.flac",clips/f"{tag}-{variant}-backing_vocals.flac",gain,"flac24")
        checks.append({"case":tag,"variant":variant,**check})
    cards.append("</div>")
page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>becruily 重叠率对比</title><style>body{font:16px/1.6 system-ui;max-width:1000px;margin:40px auto;padding:0 20px;background:#faf9f5;color:#292929}h2{margin-top:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}label{padding:15px;background:white;border:1px solid #ddd}audio{display:block;width:100%;margin-top:8px}</style><h1>becruily：原版与减少重叠</h1><p>同一份全部人声、同一权重、20秒窗口。所有试听共同增益0.9。4重叠为质量基准；3、2重叠更快，但结果改变。请比较和声里的主唱残留、和声损伤以及接缝。</p><p>本页是整曲推理后的片段，不能与独立短片段推理直接混作同一基准。</p>'''+"\n".join(cards)+"</html>"
(OUT/"试听对比.html").write_text(page,encoding="utf-8")
(OUT/"研究结果.md").write_text("\n".join(lines),encoding="utf-8")
(OUT/"verification.json").write_text(json.dumps({"profileMatchesOriginalMaxError":parity,"commonListeningGain":gain,"clips":checks},indent=2))
print(json.dumps({"profileParity":parity,"checkedPairs":len(checks),"listening":str(OUT/"试听对比.html")},ensure_ascii=False))
