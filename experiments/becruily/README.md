# becruily 推理加速与蒸馏研究

日期：2026-11-14。用户试听后选择 becruily 作为质量基准；当前优先 Windows GPU，后续 Android/iOS。约束是保留原生、可分发环境，不要求用户安装 Flash Attention、自编译 CUDA/Triton 或更换特殊 PyTorch。

本次只新增实验脚本和测量产物，未更改正式推理配置、现有权重、曲库或应用依赖。所有计算使用现有管理环境中的 PyTorch 2.11.0+cu130；RTX 3060 Laptop 6GB。当前 PyTorch 报告 `is_flash_attention_available=False`，没有安装 Triton。实验中的分组矩阵运算和候选学生均使用普通 PyTorch 算子。

## 已测结果

详见 `output/becruily-20261114/` 下的 `stages/profile.json`、`benchmark.json`、`remaining/benchmark.json`、`full/benchmark.json`、`students.json` 和 `pipeline-io/results.json`。完整数表和试听链接由 `make_report.py` 生成到该目录的 `研究结果.md`、`试听对比.html`。

本曲为用户指定《珊瑚海》，输入是上一次实验按应用现有 htdemucs_6s 流程提取的全部人声，255.467 秒。这里只计主唱/和声细分；不含上游全曲乐器分轨。

### 整曲阶段归因

| 阶段 | 秒 | 意义 |
|---|---:|---|
| Python/依赖导入 | 6.99 | 短任务更受启动开销影响 |
| 哈希与配置校验 | 0.14 | 不值得为省这点时间削弱完整性检查 |
| 音频读取 | 0.05 | 此处输入为本地 WAV |
| 构造模型、读取权重、上传 GPU | 0.78 | 常驻模型有价值，但不是当前主要瓶颈 |
| 模型前向 | 69.15 | 主要优化目标 |
| 分块准备、传输、重叠拼接、裁剪 | 约 0.46 | 不应首先重写音频 IO/拼接 |
| 残差与校验 | 0.40 | 保留混合一致性 |
| 两路浮点 WAV 写盘 | 0.33 | 本地磁盘缓存条件下 |
| 两路 FLAC24 编码 | 0.91 | 具体编码与存储设备会影响耗时 |
| 同进程 FLAC 还原校验 | 1.19 | 正式应用另启校验 worker，启动成本另测 |

被测 Python 流程约 80.48 秒；不是 GUI 按钮到完成的整条应用计时。正式任务还有解码、峰值图、数据库操作和独立校验进程，不能把这个数字当作完整应用总时延。`pipeline_io.py` 另外复现解码及新 worker 校验。

模型内部的 CUDA event 区间：时间 Transformer 39.65 秒，频率 Transformer 26.37 秒，band split 0.95 秒，mask estimator 0.53 秒，STFT/ISTFT 合计 0.18 秒。Transformer 内时间 SDPA 14.03 秒、频率 SDPA 1.05 秒；其余包括 QKV/输出投影、旋转位置编码、门控、归一化、FFN 和调度间隙。

注意：CUDA 区间包含 CPU 发射间隙，不是纯 kernel 时间；嵌套区间不能重复相加。约 66 秒耗在两轴 Transformer，而真正 SDPA 的区间约 15 秒。只替换 attention 内核不能消除其余投影/FFN 开销。即使理想化地完全省掉这 15 秒，模型前向也只约快 1.28 倍，这是基于本次剖析的上界估计，不是可实现性能承诺。

### 已否定或需要谨慎的方向

- 25 秒片段、同权重同窗口：batch 1/2 约 5.8–6.0 秒，batch 2 没有明显吞吐优势。batch 4 触发严重显存压力并长时间拖慢，停止测试；不能只等 CUDA OOM 才回退，Windows 显存溢出可能先严重降速。
- 去掉旧 SDPA 选择上下文、让原生 PyTorch 自动选择，未发现收益，输出与原版相同。
- 将等宽频带的输入/输出 Linear 分组为 bmm，没有获得提速；输出约 69.5 dB 的差分 SNR，不应当作逐位等价优化。该实验不进入正式代码。
- 10 秒窗口在 25 秒片段上反而更慢且输出差异显著。现有反射补边规则会改变实际窗口数，不能仅按“窗口缩短一半”推断加速。
- 25 秒片段中 4→2 重叠没有加速：4 重叠未触发反射补边，2 重叠触发补边，实际都是 5 个模型窗口。这说明必须用整曲验证。

保留这些负结果可避免下次重复尝试。不同序列实验温度变化明显，25 秒重复数据只能排除明显收益；不能把几个百分点波动当作优化。

## 优化优先级

1. **同一个模型的推理策略**：保留 20 秒上下文，比较 4/3/2 重叠。整曲测量及同增益音频已输出。降低重叠改变估计，必须比较主唱残留、和声误删及拼接处，不能因为两路相加还原就认定分离质量不变。正式默认先保留原版，听感通过后再提供可选快速档。
2. **减少 Transformer 的实际计算**：优先结构化减少 block 数、hidden width、attention inner width 和 FFN width；使用普通稠密矩阵算子。只把部分权重置零通常不能让现有 dense GPU 算子更快。
3. **独立压缩输出头**：模型共 51,049,484 参数，Transformer 25,258,240，输出头 24,721,416。输出头接近半数参数，却不到 1% 被测前向时间，主要价值是减小下载、存储与训练状态。对大 Linear 低秩分解、缩小隐藏层、共享一部分输出头再蒸馏恢复，均比只减 block 更能缩小文件。
4. **固定形状与批处理控制**：按可用显存选择 batch，保留安全余量，不能按显卡型号或总显存固定扩大。不要为了静态 batch 给所有片尾都多算昂贵窗口。可继续评估静态图/算子融合，但作为离线构建产物验证，不能让用户安装编译链。
5. **任务级启动成本**：将只涉及 soundfile/numpy 的编码校验移到轻量 worker/module，或者复用 worker；先测验证进程启动开销。常驻服务需要同时处理空闲释放、取消与崩溃隔离，不能无限占用显存。

## 蒸馏候选：实测大小，而非按层数猜大小

`students.py` 实际构造了以下结构，保留 44.1kHz 立体声、原 STFT 和频带定义。速度为当前 GPU 上 batch=1、4 秒音频、FP16 单次前向的 5 次中位数，不含重叠推理、IO，也不是手机速度。

| 模型 | 结构 | 参数 | FP16 原始参数体积 | 前向 |
|---|---|---:|---:|---:|
| 原教师 | 12 层，dim=256，8×64 attention | 51.05M | 102.1MB | 224ms |
| 中间学生 | 6 层，其余不变 | 38.42M | 76.8MB | 121ms |
| 建议首个小模型 | 6 层，dim=128，4×32，mask expansion=2 | 7.07M | 14.1MB | 67ms |
| 更小对照 | 4 层，dim=128，4×32，mask expansion=2 | 6.28M | 12.6MB | 51ms |
| 移动激进对照 | 4 层，dim=96，3×32，mask expansion=2 | 4.03M | 8.1MB | 53ms |

体积未计模型图、buffer 和封装开销。4M 模型并不比 6M 模型更快，再次说明参数量不能代替设备测量。单纯减半 block 只减少约 25% 参数，因为输出头没有减少。

6 层宽学生使用教师第 1/3/5/7/9/11 层（零起始）初始化；7M 学生为随机初始化。两者完成 3 个实际反向更新，梯度有限，损失下降；4 秒 batch=1、激活检查点条件下分别约 1.12GB、0.35GB 的 PyTorch 峰值分配显存。这个数字不包含桌面程序和 CUDA allocator 保留量。

**三步测试仅验证训练可以运行，没有训练出可用小模型，也不能证明保留了 becruily 音质。** 不提供随机学生音频冒充蒸馏样例；未保存/发布这些测试权重。

## 可实施的蒸馏流程

### 数据与教师缓存

- 输入必须覆盖应用真实的 all-vocals 分布；真实分离人声含有伴奏泄漏、混响和编码误差，不能只用干净人声训练。
- 先做 10–20 小时多曲目试验，再依据独立验证曲线决定是否扩大到 100 小时以上；这是研发起点，不是已证实的数据需求。
- 包含：不同歌手、同人高低和声、同音 double、弱和声、密集副歌、独唱、无主唱/仅和声、空白段、男女角色交接。尽量加入有真实独立轨的素材。
- 先以完整长上下文、质量基准设置运行 becruily，缓存其目标和输入；残差可即时 `V-L_teacher` 计算。训练时从缓存裁剪 4–8 秒，避免教师跟着小窗口变差。不要分别归一化教师两路；保留时间、声像、采样率和相对增益。
- 《珊瑚海》已用于开发与训练 smoke，应放在开发试听集，另建从未用于调参的测试集。按歌曲、歌手/制作来源划分 train/validation/test，同一首歌的相邻片段、不同编码版不能分到两侧。
- 教师伪标签会继承教师的误分，需按试听与一致性筛选；有真实轨时加入监督损失，不能把“像老师”与“分得正确”混为一谈。

44.1kHz 立体声 float32 的输入加教师一路约 2.54GB/小时，100 小时约 254GB（未压缩）。要提前规划缓存；FLAC 压缩率取决于素材。教师计算量可按本机整曲测得 RTF 估算，但不包含生成 all-vocals 的上游分轨成本。

### 训练目标

第一版建议用同采样率、同频带的 7M 学生直接学习教师。6 层宽学生是较低结构风险的对照或中间教师，是否有帮助要比较，不能预设分阶段蒸馏一定更好。

组合：保增益 waveform L1；多分辨率 complex STFT；教师复数掩码蒸馏；有真实轨时的真实监督；针对弱和声/空目标段的额外采样和损失。先比较输出级蒸馏，再考虑中间层特征匹配，避免一开始堆叠多种约束。

对于 `Hs=V-Ls`、`Ht=V-Lt`，两路普通 waveform L1 的误差完全相同：`|Hs-Ht|=|Ls-Lt|`。把它们直接相加只是加权同一个损失，不能宣称得到了独立的和声监督。可通过和声相对能量归一化、和声 log-magnitude STFT、真实和声目标、弱和声分段采样来改变优化重点；静音必须有分母下限，防止梯度爆炸。

不要只用 SI-SDR，它对全局缩放不敏感，不足以保证输出适合相减。复数 mask 在输入频谱接近零时也要做能量加权/屏蔽；从后处理后的教师波形反推 mask 会有病态除法，应优先直接捕获教师 mask，或先用稳定的复数频谱输出蒸馏。

起步训练配置建议：AdamW、混合精度、4 秒起步逐渐增加到 8 秒、按显存定 batch、梯度累积与激活检查点。新模型可从 1e-4 量级搜索，复制教师参数的学生从更小学习率搜索。需验证集选模型，三步 smoke 的损失不是训练配方的质量证据。

### 压缩方法的取舍

| 方法 | 优先级 | 与原生分发的关系 |
|---|---|---|
| 层/通道/attention head 结构化缩小 + 蒸馏 | 高 | 生成普通更小的稠密网络，部署最直接 |
| 输出头低秩分解 + 蒸馏微调 | 中高 | 普通两个 Linear；秩过小会损失音色细节；小矩阵拆分未必更快 |
| 跨频带共享输出头 + band embedding | 中 | 能明显缩小权重，但要重新训练、验证各频带细节 |
| 局部时间注意力 + 少量全局汇聚 | 中 | 模型方法可借鉴，先实现为实际分窗的小矩阵计算；整张 N×N 加 mask 不会减少计算 |
| FP16 | 已用 | 当前已有 AMP，不能重复计作新收益；序列化 FP16 主要再减文件大小 |
| INT8/QAT | 学生音质稳定后 | 必须验证所选移动后端真实执行该精度；weight-only 小并不保证执行更快 |
| 无结构稀疏/只把权重置零 | 低 | 普通 dense 算子通常仍执行同样大小的计算 |

## Android / iOS 设计约束

模型训练环境与用户推理环境分开：训练工具可以放在开发机，但产品只交付转换后的普通推理模型及官方运行库。转换与校验应在构建阶段完成，用户无需 Python、编译器或 Flash Attention。

建议把 STFT/ISTFT、overlap-add、残差放在平台 DSP 层，网络只处理固定形状的实数/虚数频谱张量并输出复数 mask。这样避免让移动加速器承担动态复数 FFT；必须逐帧验证窗函数、center/padding、幅度归一化、声道顺序和长度与桌面一致。

网络侧优先采用固定 chunk、固定 band、普通 Linear/Conv/归一化/激活；转置和 reshape 也要检查是否形成 CPU/GPU 来回搬运。局部 attention 如果采用，必须物理划窗并限制实际矩阵大小，配套边界上下文训练。

- Android：评估标准 ONNX Runtime / LiteRT 路径，CPU 是覆盖面较广的回退，GPU/NPU 要分别实测。Qualcomm QNN 只覆盖对应芯片，不能当作全 Android 方案。
- iOS：在 Mac 上验证 Core ML 导出和真机执行；检查计算是否落在预期 GPU/ANE、是否分段回落。不能从 PC CUDA 成绩推断手机性能。
- 先做 FP16 音质与稳定性，再做 INT8/QAT；端上测峰值内存、持续处理温升和电耗，以及一次整曲与长批次，不能只看一个 4 秒窗口。

## 验收建议

实验分三道检查：导出数值一致性；小模型对真实轨的主唱/和声质量与对教师差异；目标设备整曲速度/内存/温升。两路相加还原仅验证信号契约，不验证角色分对。

研发目标可先设为：移动学生 FP16 权重约 15MB 以内；当前 GPU 同输入/同重叠设置明显优于教师；对独立测试集的弱和声损伤与主唱残留均不明显增加。若使用 SDR 差距门槛，应在有真值的测试集上定义（例如中位数不退化超过 0.5dB、困难分位单列），最终仍需盲听，目标不是已取得成绩。

## 依据与适用范围

- [becruily 官方配置](https://huggingface.co/becruily/bs-roformer-karaoke/blob/main/config_karaoke_frazer_becruily.yaml)：本地 pin 与其结构对应。仓库无 model card，训练数据和新衍生模型的授权范围需另核实，不能从基础代码 MIT 推导权重许可。
- [BS-RoFormer 论文](https://arxiv.org/abs/2309.02612)：两轴频带 Transformer 的结构依据。
- [Windowed Sink Attention 论文](https://arxiv.org/html/2510.25745v1)：在 Mel-Band 人声/伴奏任务中，用 mask 蒸馏恢复局部注意力模型；结果 12.12→11.17dB，串音指标有所下降。44.5× 指 attention 计算量，不是完整模型墙钟加速，也不是 becruily 主唱/和声任务已验证的收益。
- [作者实现](https://github.com/smulelabs/windowed-roformer)：依赖 flex_attention/torch.compile 的部署方式不直接纳入本项目通用 Windows 方案；研究的是结构和蒸馏目标。
- [Apple PyTorch→Core ML](https://apple.github.io/coremltools/docs-guides/source/convert-pytorch-workflow.html)、[Google PyTorch→LiteRT](https://developers.google.com/edge/litert/conversion/pytorch/overview)、[ONNX Runtime QNN](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)：只是可评估的官方导出/后端路径，不代表本模型已完成转换。

## 复现

```powershell
$py = "$env:LOCALAPPDATA\BandBuddy\envs\env\Scripts\python.exe"
& $py experiments/becruily/profile_stages.py
& $py experiments/becruily/benchmark.py --input output/singer-informed-20261114/source/vocals.wav --output output/becruily-20261114/full --variants baseline-b2-t8 overlap3-b2 overlap2-b2 --repeats 1 --short-warmup
& $py experiments/becruily/students.py
& $py experiments/becruily/pipeline_io.py
& $py experiments/becruily/make_report.py
```

本次 batch4 已因显存压力停止，默认复现命令不包含它。Benchmark 输出差分 SNR 是相对原模型的波形差异，不是有真值的分离 SDR。整曲配置目前单次测量，重复短片段用于排除明显无效优化；持续温度/频率变化限制小幅百分比结论。
