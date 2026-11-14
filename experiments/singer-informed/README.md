# Singer-Informed：珊瑚海接入实验（2026-11-14）

已将“参考歌声指定目标 → 提取 → 从同一份全部人声相减”的实验链路跑通，复用现有 `vocal_separator.separator.split_arrays` 和 `verify_encoded`，未修改正式模型菜单、任务协议或曲库。试听确认仍由用户完成；工程校验不代表音质通过。

## 素材与试听

- 用户指定：`C:\Users\zhaoj\Downloads\周杰伦 _ Lara梁心颐 - 珊瑚海.flac`，255.467 秒。
- 上游人声：当前应用的 `worker.py separate-demucs`，本地已校验的 `htdemucs_6s`，CUDA、shifts=1、overlap=0.25、segment=7。
- 参考候选：男声 00:26–00:29，女声 00:41–00:44；来自同一份全部人声，未进行自动主唱检测，也未确认参考完全无其他声部。
- 片段：01:08–01:33、03:25–03:50；另外保留参考附近的 8 秒控制段。控制段可能包含另一位歌手，不是可靠空目标标签。
- 输出目录：`output/singer-informed-20261114/`；打开 `试听对比.html`。包括参考、输入、两种现有模型、新模型男／女参考输出、Concat 负对照、原版单声道对照，以及整曲 FiLM 结果。
- 每个方法输出 `lead_vocals.wav` 和 `backing_vocals.wav`，沿用现有文件契约；在此实验里分别指“指定歌手目标”和“输入减目标的残差”。女声提取时文件名同样如此，不能据此判断音乐角色。
- 所有试听 FLAC 使用同一个增益，未逐轨归一化；原始浮点 WAV 保留原比例。`export-verification.json` 保存共同增益及每一组无损还原检查。

《珊瑚海》验证的是不同歌手身份提取，不是同一个人叠录的主唱／和声。残差可能同时含另一歌手、目标漏提和上游杂音，不能直接标为纯和声。

## 实测关键发现

作者仓库：[singer-separation-paper](https://github.com/jocelynxu01/singer-separation-paper)，本次源码 commit `3f6ce09d53750b55f52801a24efff369dbd04846`。未修改上游模型代码，也未用推理时补丁改变已训练网络语义。

**公开 Concat + dual loss λ=0.1 在当前源码与对应权重组合下忽略参考。** `openunmix/model.py` 的 `OpenUnmix_Embedding.forward` 先把 32 维参考追加在全部 2049 个频率 bin 后，再裁剪到 `nb_bins + emb_dim = 1487 + 32 = 1519`。参考始于索引 2049，全部被裁掉。权重 `input_mean` 长度 1487、`fc1.weight` 形状 512×1519 与此对应。

实际加载权重，给完全不同的随机参考，输出逐值完全相同；本曲男声／女声参考也得到完全相同的 Concat 输出。见 `conditioning-audit.json`、各片段的 `concatReferenceSwitchMaxDifference=0`。因此不能将该公开组合当作参考条件提取器接入。仅修推理阶段的拼接顺序不能使已训练权重自动学会声纹；应向作者确认相匹配的代码／checkpoint，或修正后重训。这个发现针对公开代码与权重组合，不是对论文方法本身的否定。

**FiLM + dual loss λ=0.1 的参考路径有效。** 同样加载作者公开权重，随机参考及本曲男／女参考均会改变输出。在 00:26–00:34 的男声参考附近控制段，男声参考输出 RMS 0.07878，女声参考输出 RMS 0.002493，相差约 29.99 dB。这只能证明条件产生了明显影响，该段与注册参考还有重叠，不能当作独立测试集成绩或分离质量提升分数。

两个重叠片段均保存了男／女参考提取、互补残差，以及现有 `mel-karaoke-aufr33-viperx`、`bs-karaoke-frazer-becruily` 的同输入结果。没有原始独立录音轨，不计算误导性的 SI-SDR，也不预先认定新模型听感更好。

## 接入边界

模型为 44.1 kHz 单声道幅度掩码网络。本次立体声适配从左右声道波形平均值预测实数掩码，再将同一掩码作用于原始 L/R 复数频谱。保持帧数、采样率、相位时间轴和原增益，用 `input - target` 计算残差。掩码未裁剪到 0–1，保持作者网络的输出语义。

第一段另存 `author_mono_target`／`author_mono_residual`，便于区分原版单声道能力和立体声适配的影响。FiLM 男／女目标是两次独立推理，不保证两目标本身相加等于输入；每个目标与自己的残差保证相加还原。

当前适合保留为实验入口。正式接入还需要：试听接受；可靠参考选择与角色交接设计；同人叠录、无目标场景和更广曲库测试；确定根目录代码、歌手编码器及权重许可。Open-Unmix 子目录含 MIT 许可，但不能据此推定全部新增代码和权重均可商业分发。本次没有复制权重到应用资源或构建安装包。

## 复现

使用 BandBuddy 管理的 Python（需 torch、torchaudio、numpy、scipy、soundfile、yaml 和现有 RoFormer 依赖）。下载工具使用独立 venv，未修改应用环境。

```powershell
$py = "$env:LOCALAPPDATA\BandBuddy\envs\env\Scripts\python.exe"
git clone --depth 1 https://github.com/jocelynxu01/singer-separation-paper.git .tmp/singer-informed/upstream
python -m venv .tmp/singer-informed/tools-env
.tmp/singer-informed/tools-env/Scripts/python.exe -m pip install gdown
.tmp/singer-informed/tools-env/Scripts/python.exe -m gdown --folder 'https://drive.google.com/drive/folders/1ovJF41lq71FhCwD44qRHkrAr_bX3_ki3' -O .tmp/singer-informed/checkpoints/concat-dual-0.1
.tmp/singer-informed/tools-env/Scripts/python.exe -m gdown --folder 'https://drive.google.com/drive/folders/1Ie_yzfhz0VCFS4GC136Rq3YXnqYPHD7_' -O .tmp/singer-informed/checkpoints/film-dual-0.1
.tmp/singer-informed/tools-env/Scripts/python.exe -m gdown 'https://drive.google.com/uc?id=1DTzLtKgtxBdwuOD5D4K8b9Ugj8PSN-EA' -O .tmp/singer-informed/checkpoints/embedding-clean.pth
resources/bin/ffmpeg.exe -y -v error -i "$env:USERPROFILE\Downloads\周杰伦 _ Lara梁心颐 - 珊瑚海.flac" -ar 44100 -ac 2 -c:a pcm_f32le .tmp/singer-informed/input.wav
& $py python/worker/worker.py separate-demucs --input .tmp/singer-informed/input.wav --output output/singer-informed-20261114/source --model-root "$env:LOCALAPPDATA\BandBuddy\envs\models" --device cuda
& $py experiments/singer-informed/run.py audit
& $py experiments/singer-informed/run.py run
& $py experiments/singer-informed/run.py extract
& $py experiments/singer-informed/run.py export
& $py experiments/singer-informed/make_report.py
& $py -m unittest discover -s python/vocal_separator/tests -p test_*.py
```

运行 `run.py --help` 可指定输入人声、模型根目录、参考时间、片段时间和输出目录。`extract` 按固定参考处理完整人声，不执行自动主唱角色跟踪。`make_report.py` 为本曲生成固定输出目录的试听报告。

本次模型 SHA-256：

- Concat：`691e52121e63529d29ea7d06dd4ce08e91789d47fe5ffeed1782a83c14c4ed48`
- FiLM：`253b803dc325c1c01355572944241a88b07d02246db67e8a5e003bea75092340`

完整来源哈希、参考有效性和无损导出检查记录保存在实验输出目录。
