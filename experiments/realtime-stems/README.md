# Windows 电脑音频实时消鼓实验 · 2026-11-07

在 RTX 3060 Laptop（6 GB）、Ryzen 7 5800H 上，BandBuddy 已安装的 HTDemucs 6s 可以把系统正在播放的音乐连续变成无鼓伴奏。平衡档适合先做带固定延迟的外部伴奏。对着外部视频练习会有可见的声画差，演奏者自己的监听应走独立直通路径。这里的原型独立于 BandBuddy 主程序。

## 测试链路

测试播放器 → UU 虚拟播放设备 → WASAPI 回录（48 kHz 双声道）→ 连续重采样至 44.1 kHz → HTDemucs 估计鼓轨 → 原混音减去对齐的估计鼓轨 → 重采样至 48 kHz → Realtek 播放设备。用两端的 WASAPI 回录定位同一段波形，保留 6 个测点。结果含采集、模型、队列和设备处理。测量精度受回调调度和输出端波形变化影响，扬声器至耳朵的声学延迟未测。

源应用需要单独路由至虚拟设备，并关闭该设备到物理扬声器的直通。普通 loopback 会复制已经送去播放的混音；源应用和处理结果都送往同一物理输出时，原鼓仍会被听见，也可能把处理结果再次送进模型。Windows 的进程回录可以按进程树选择或排除采集对象，但仍要处理原声的播放路由。[Microsoft Application Loopback 示例](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)

模型按块复用现有权重，在实验实例上关闭训练长度补齐，保留过去的音频，只取窗口靠右的一段作为当前输出，并做 10 ms 交叉淡化。开头用零填历史，工作线程在推理前等待本块和少量未来音频，音频回调只收发 PCM。类似的偏移取块方法也有针对 HTDemucs 的研究。[Demucs 项目](https://github.com/facebookresearch/demucs) · [Adapting offline models to a streaming context for music source separation](https://arxiv.org/abs/2609.35397)

## 吞吐与质量

GPU 耗时来自《没有理想的人不伤心》50–80 秒，逐块回放文件数据，预热后计时，包含 GPU 传输和结果取回。CPU 使用 4 个 PyTorch 线程，在 5 秒参考素材上复测。两者的计时均不含音频设备。

| 档位 | 历史 / 每块输出 / 未来音频 | GPU 单块 P95 | GPU 超出块时长 | CPU 单块 P95 |
|---|---|---:|---:|---:|
| 快速 | 420 / 60 / 20 ms | 58 ms | 23 / 500 | 205 ms |
| 平衡 | 1200 / 120 / 100 ms | 54 ms | 0 / 250 | 416 ms |
| 长窗口 | 2280 / 240 / 240 ms | 68 ms | 0 / 125 | 854 ms |

平衡档要收到 220 ms 的音频才能计算第一块，1200 ms 的历史从零开始积累。把第一块的等待、推理和实际输出路由相加，才对应播放器用户的体验。

双端回录使用 10 ms 音频回调并给输出预留 40 ms。每次播放 20 秒，快速档两次测量落在 **351–381 ms**，平衡档两次分别为 **619–634 ms** 和 **491–505 ms**。同一套设备和回调直接转发音频，绕过模型与重采样，仍测到 **224–239 ms**。快速档两次分别缺了 502 和 0 个输出帧，平衡档分别缺了 0 和 22 个（48 kHz 下约 0.46 ms）；短测未发现输入队列丢包。各档的单块推理耗时不足以预测上述波动。Realtek 回录与原混音的相关系数约 0.49–0.58，即使旁路也在相近范围，延迟按区间解读。长窗口档只测了文件流和质量。

为避免用模型自己的离线输出当答案，取官方 MUSDB18 七秒示例压缩包中按归档顺序出现的前 12 个 test 曲目。解码原始鼓、贝斯、其他和人声流，求和作为输入，后三轨之和作为理想无鼓伴奏。下表为各曲独立计算后取中位数。离线对照对同一个短片段调用默认训练窗口，单次推理。它代表本次短片段基准。[SigSep 七秒样本与音轨定义](https://github.com/sigsep/sigsep-mus-db)

| 档位 | 输出中与原鼓轨同相的分量 | 与原伴奏同相的分量 | 相比直接播放原曲，更接近无鼓参考的幅度 |
|---|---:|---:|---:|
| 快速 | −19.38 dB | −0.89 dB | 6.14 dB |
| 平衡 | −18.33 dB | −0.49 dB | 7.87 dB |
| 长窗口 | −18.76 dB | −0.35 dB | 8.23 dB |
| 离线对照 | −19.79 dB | −0.28 dB | 8.78 dB |

前两列将输出同时对原鼓轨和原伴奏做最小二乘拟合，再将两个增益换算为 dB。最后一列为 `10 log10(原鼓能量 / 输出与无鼓参考的误差能量)`，同时计入残鼓与被误伤的其他声部。平衡档这项改善逐曲为 2.70–14.72 dB。另一个独立的 TorchAudio 教程五秒例子仅改善 2.29 dB，鼓分量仅衰减 3.76 dB，即使离线也只衰减 4.09 dB。听感会随编曲和录音变化。[逐曲结果与端点测量](results.json) · [TorchAudio 教程与参考分轨](https://docs.pytorch.org/audio/2.5.0/tutorials/hybrid_demucs_tutorial.html)

## 在本机试听

从项目根目录执行。通过 Windows 音量混合器把浏览器或播放器单独路由到虚拟播放设备。先列设备，再按当时的名称选编号。当前环境的 13 是 UU 虚拟设备，12 是 Realtek。脚本不修改系统默认输出。

```powershell
$py = "$env:LOCALAPPDATA/BandBuddy/envs/env/Scripts/python.exe"
$env:PYTHONPATH = (Resolve-Path 'output/realtime-stems/pylibs').Path
& $py experiments/realtime-stems/wasapi_probe.py
& $py experiments/realtime-stems/wasapi_probe.py --source 13 --monitor 12 --profile balanced --stem drums --listen-seconds 60
```

试听模式只在内存中处理所选播放设备的音频。可指定模型提供的 drums、bass、vocals、guitar、piano 或 other，本次的质量和延迟评估针对 drums。脚本要求两个不同的 48 kHz 立体声 WASAPI 播放端点。

## 复现测量

依赖使用 BandBuddy 自带的 PyTorch、Demucs、NumPy、SciPy、SoundFile、soxr，以及单独安装到实验输出目录的 PyAudioWPatch 0.2.12.9。权重为 `5c90dfd2-34c22ccb.th`，脚本会在本地加载前校验 SHA-256。下面在仓库根目录运行。

```powershell
$data = New-Item -Force -ItemType Directory 'output/realtime-stems'
python -m pip install --no-deps --target "$data/pylibs" PyAudioWPatch==0.2.12.9
$env:PYTHONPATH = (Resolve-Path "$data/pylibs").Path
$py = "$env:LOCALAPPDATA/BandBuddy/envs/env/Scripts/python.exe"
foreach ($part in 'bass','drums','other','vocals') {
    curl.exe -fsSL "https://download.pytorch.org/torchaudio/tutorial-assets/hdemucs_${part}_segment.wav" -o "$data/$part.wav"
}
& resources/bin/ffmpeg.exe -loglevel error -y -ss 50 -i '测试用例/新裤子 - 没有理想的人不伤心.mp3' -t 30 -ar 44100 -ac 2 -c:a pcm_f32le "$data/music.wav"
& $py experiments/realtime-stems/probe.py --music "$data/music.wav"
& $py experiments/realtime-stems/probe.py --device cpu
& $py experiments/realtime-stems/wasapi_probe.py --source 13 --monitor 12 --profile balanced
```

双端测量模式会在源设备播放 20 秒已知音频，并将低电平结果送到监听设备。可将档位改为 fast 或 bypass 对照。多曲评估使用 SigSep v0.4.0 发布的 `MUSDB18-7-STEMS.zip`，将本实验结果 JSON 列出的 12 个 `test/*.stem.mp4` 文件置于 `output/realtime-stems/musdb-test`，运行 `musdb_probe.py`。输出目录还保存 30 秒原曲及同长度消鼓 WAV，便于同位置 A/B。[SigSep 样本发布页](https://github.com/sigsep/sigsep-mus-db/releases/tag/v0.4.0)

## 更低延迟的候选

对几十毫秒的外部监听目标，值得独立验证因果模型和原生音频缓冲。Band-SCNet 论文报告 92 ms 延迟和 7.79 dB 的 MUSDB18-HQ SDR，指标属于论文条件，和上表的投影衰减、参考误差改善采用不同定义。xumx-sliCQ 提供 realtime 权重，可以作为另一个实现对照。本轮没有在本机测试这两个模型，也未验证长时间运行、USB 声卡或蓝牙设备。[Band-SCNet 论文](https://www.isca-archive.org/interspeech_2025/yang25d_interspeech.pdf) · [xumx-sliCQ 项目](https://github.com/sevagh/xumx-sliCQ)
