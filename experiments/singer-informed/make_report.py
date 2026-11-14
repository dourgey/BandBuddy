"""Build a local, offline listening report from verified experiment artifacts."""
import html
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output/singer-informed-20261114"
results = json.loads((OUT / "results.json").read_text(encoding="utf-8"))
export = json.loads((OUT / "export-verification.json").read_text())
audit = json.loads((OUT / "conditioning-audit.json").read_text())


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


original = Path.home() / "Downloads/周杰伦 _ Lara梁心颐 - 珊瑚海.flac"
provenance = {
    "originalPath": str(original), "originalSha256": digest(original),
    "sourceVocalsSha256": digest(OUT / "source/vocals.wav"),
    "upstreamCommit": subprocess.check_output(["git", "-C", str(ROOT / ".tmp/singer-informed/upstream"), "rev-parse", "HEAD"], text=True).strip(),
    "embeddingCheckpointSha256": digest(ROOT / ".tmp/singer-informed/checkpoints/embedding-clean.pth"),
    "demucsSettings": {"model": "htdemucs_6s", "shifts": 1, "overlap": .25, "segment": 7, "device": "cuda"},
    "demucsCheckpointSha256": digest(Path.home() / "AppData/Local/BandBuddy/envs/models/bandbuddy-stems-v2.0.1/5c90dfd2-34c22ccb.th"),
    "authorSourceModified": False, "songDatabaseModified": False,
    "subjectiveQualityAccepted": False,
}
(OUT / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2), encoding="utf-8")


def audio(label, relative):
    if not (OUT / relative).is_file():
        raise FileNotFoundError(relative)
    return f'<label>{html.escape(label)}<audio controls preload="none" src="{quote(relative)}"></audio></label>'


parts = ['''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>珊瑚海 · 分离试听</title>
<style>body{font:16px/1.65 system-ui,sans-serif;max-width:1080px;margin:40px auto;padding:0 24px;background:#f8f7f3;color:#252525}h1{font-size:32px}h2{margin-top:38px}p{max-width:900px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px}label{display:block;padding:16px;background:white;border:1px solid #ddd;border-radius:8px}audio{display:block;width:100%;margin-top:10px}.note{padding:16px;background:#eeeadf;border-left:3px solid #81724c}button{font:inherit;padding:8px 14px;margin:0 6px 12px 0}a{color:#365b75}small{color:#555}</style>
<h1>《珊瑚海》参考歌声分离试听</h1>
<p>本地原始 FLAC → BandBuddy 现有 htdemucs_6s 全部人声 → 参考指定歌手 → 提取目标／从同一输入相减。新方法：Singer-Informed FiLM + dual loss λ=0.1。所有 FLAC 使用同一个增益，没有逐轨归一化。</p>
<p class="note">这首是双人合唱。指定男声后，残差应保留女声及未提取部分；它不能直接等同于纯和声。输出能随参考改变，不代表已经分得干净。未获得原始独立录音轨，不能给出可靠 SI-SDR 或宣称胜过现有模型。</p>
<button onclick="switchTime=!switchTime;this.textContent=switchTime?'切换时保留片段内进度：开':'切换时保留片段内进度：关'">切换时保留片段内进度：开</button><button onclick="document.querySelectorAll('audio').forEach(a=>a.pause())">暂停全部</button>
<h2>参考片段</h2><p>从全部人声中人工指定的候选：男声 00:26–00:29，女声 00:41–00:44。请先听参考是否足够单一；没有进行自动主唱检测。</p><div class="grid">''']
parts += [audio("男声参考候选", "references/male.flac"), audio("女声参考候选", "references/female.flac"), "</div>"]
for case in results["cases"][:2]:
    name = case["name"]
    start = int(case["start"])
    end = start + int(case["duration"])
    stamp = lambda n: f"{n//60:02d}:{n%60:02d}"
    parts += [f'<section><h2>重叠片段 {stamp(start)}–{stamp(end)}</h2><p>先比较新旧残差里的男声残留和女声损伤，再比较目标声里的女声串入。直接点击另一个播放器，可在本片段内保留进度。</p><div class="grid">']
    for label, path in [
        ("输入：全部人声", "input_vocals.flac"),
        ("新方法 · 男声参考 → 提取目标", "film-male/lead_vocals.flac"),
        ("新方法 · 男声参考 → 相减残差", "film-male/backing_vocals.flac"),
        ("新方法 · 女声参考 → 提取目标", "film-female/lead_vocals.flac"),
        ("新方法 · 女声参考 → 相减残差", "film-female/backing_vocals.flac"),
        ("现有 becruily · 主唱", "bs-karaoke-frazer-becruily/lead_vocals.flac"),
        ("现有 becruily · 和声残差", "bs-karaoke-frazer-becruily/backing_vocals.flac"),
        ("现有 aufr33-viperx · 主唱", "mel-karaoke-aufr33-viperx/lead_vocals.flac"),
        ("现有 aufr33-viperx · 和声残差", "mel-karaoke-aufr33-viperx/backing_vocals.flac"),
    ]:
        parts.append(audio(label, name + "/" + path))
    parts += ["</div><details><summary>Concat 负对照与原版单声道</summary><p>公开 Concat 推理路径丢掉参考向量，男／女参考输出逐样本完全相同。未自行修补后冒称论文模型。原版单声道与立体声掩码适配另存，方便比较。</p><div class=\"grid\">"]
    parts.append(audio("公开 Concat · 提取目标（换参考无变化）", name + "/concat-male/lead_vocals.flac"))
    if name == "duet-01":
        for target, label in (("male", "男"), ("female", "女")):
            parts.append(audio(f"FiLM 原版单声道 · {label}声参考目标", f"{name}/film-{target}/author_mono_target.flac"))
            parts.append(audio(f"FiLM 原版单声道 · {label}声参考残差", f"{name}/film-{target}/author_mono_residual.flac"))
    parts += ["</div></details></section>"]
parts += ["<section><h2>整曲 04:15</h2><p>固定同一参考处理整曲，适合检查歌手是否串入、声音是否忽强忽弱。这里按歌手身份提取，不会自动跟随主唱角色的交接。整曲上下文与片段独立推理可能产生差异。</p><div class=\"grid\">"]
parts.append(audio("整曲：全部人声", "source/vocals.flac"))
for target, label in (("male", "男"), ("female", "女")):
    for stem, title in (("lead_vocals", "提取目标"), ("backing_vocals", "相减残差")):
        parts.append(audio(f"整曲 · {label}声参考 → {title}", f"full-song/film-{target}/{stem}.flac"))
parts += ["</div></section><h2>工程验证与限制</h2>"]
parts.append(f'<p>{len(export["checks"])} 组 44.1 kHz 立体声输出通过长度、格式与 FLAC 相加还原校验；共同试听增益 {export["commonListeningGain"]:.6f}。最大还原误差 {max(c["reconstructionMaxError"] for c in export["checks"]):.3g}。这些是信号完整性检查，不是分离质量评分。</p>')
parts += ['''<p>立体声适配：在左右声道波形平均值上预测掩码，再将相同掩码作用于原始左右复数频谱，最后用输入减目标得到残差。原论文模型本身为单声道；此适配不等同于训练过的立体声模型。男声、女声两次独立提取的目标不保证互补；只有每次目标与其对应残差保证相加还原输入。</p>
<p>当前只建立实验脚本，没有修改正式模型菜单或曲库。尚未测试同一歌手叠录、自动参考选择或已知空目标数据。论文仓库根目录及权重未见明确商业分发许可，应在正式打包前核实。</p>
<p><a href="results.json">片段推理记录</a> · <a href="conditioning-audit.json">参考有效性审计</a> · <a href="export-verification.json">导出校验</a> · <a href="full-song/results.json">整曲记录</a></p>
<script>let switchTime=true;document.addEventListener('play',e=>{let a=e.target;if(a.tagName!=='AUDIO')return;let previous=[...document.querySelectorAll('audio')].find(b=>b!==a&&!b.paused);if(previous){if(switchTime&&previous.closest('section')===a.closest('section')&&a.closest('section'))a.currentTime=Math.min(previous.currentTime,a.duration||previous.currentTime);previous.pause();}},true);</script></html>''']
(OUT / "试听对比.html").write_text("\n".join(parts), encoding="utf-8")
print(OUT / "试听对比.html")
