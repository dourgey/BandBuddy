# becruily 主唱／和声分离模型蒸馏方案

版本：0.1  
日期：2026-11-15  
状态：研发方案，尚未训练出可用学生权重

## 1. 结论

BandBuddy 的第一版学生模型应保留 becruily 使用的 BS-RoFormer 任务定义、44.1 kHz 立体声输入、STFT 和频带划分，将模型缩为 6 层、`dim=128`、4 个 attention heads、`dim_head=32`、FFN expansion 2。该候选实测为 7,068,124 参数，FP16 原始权重约 14.1 MB，是当前最平衡的桌面／移动共同基线。

训练不应只复制教师输出。推荐采用两类数据联合训练：

1. 有独立主唱／和声轨的数据，以真实轨为主要监督，并加入 becruily 教师目标。
2. 用户提供的普通成品歌曲，经过 BandBuddy 上游人声提取后，用 becruily 生成伪标签，补足中文流行音乐和实际发行母带分布。

首轮目标不是一步得到最终移动模型，而是验证 7M 学生能否在当前 Windows GPU 上达到至少 2 倍的整曲加速，同时把真实轨测试集的中位分离质量控制在教师 0.5 dB 以内，并通过盲听。之后才评估局部注意力、输出头低秩化和 INT8/QAT。

本方案不依赖 Flash Attention、Triton、自编译 CUDA 扩展或用户侧编译环境。模型转换和量化只发生在开发／构建阶段，用户安装包只携带普通权重、固定推理图和正式运行库。

## 2. 目标与边界

### 2.1 产品任务

输入不是整首歌曲，而是 BandBuddy 上游分离得到的“全部人声”立体声：

```text
V = lead + backing + 上游泄漏与伪影
```

学生模型只预测主唱：

```text
Ls = Student(V)
Bs = V - Ls
```

`lead_vocals` 表示模型认定的主要歌唱角色，`backing_vocals` 是输入人声减去主唱后的互补残差。两路必须保持原长度、声道、声像和相对增益，且满足 `Ls + Bs = V`。

### 2.2 需要覆盖的音乐场景

- 单主唱、无和声；
- 弱和声、密集叠唱、合唱层；
- 同一歌手 double、同音／八度 unison；
- 男女对唱、轮流主唱和角色交接；
- 主唱短暂停顿但和声持续；
- 和声比主唱更响或声像更居中；
- 强混响、延迟尾音、失真、电话音色、vocoder；
- 上游人声分离产生的伴奏泄漏、相位误差和编码误差。

不能把“最响的人声”硬编码为主唱。MedleyVox 已记录主唱静音处被其他声部错误填充、角色误选和长音频身份切换等典型失败，训练和测试必须专门覆盖这些场景。

### 2.3 非目标

- 第一阶段不重写 BandBuddy 的完整人声／伴奏分离模型；
- 不要求实时监听，先完成离线整曲分离；
- 不在首轮同时更换 STFT、频带设计、网络结构、推理后端和量化精度；
- 不以参数量、FLOPs 或短窗口成绩代替目标设备的整曲墙钟时间；
- 不把三步反向传播 smoke test 当成训练质量证据。

## 3. 当前教师基线

### 3.1 教师结构

当前教师来自 `becruily/bs-roformer-karaoke`，本地配置为：

| 项目 | 当前值 |
|---|---:|
| 采样率／声道 | 44.1 kHz、stereo |
| STFT | FFT 2048、hop 512、window 2048 |
| Transformer blocks | 12 |
| hidden dimension | 256 |
| attention | 8 heads × 64 |
| FFN expansion | 4 |
| 输出 | 1 个主唱 complex mask |
| 推理窗口 | 20 秒 |
| overlap | 4 |
| batch | 2 |
| 参数量 | 51,049,484 |

BS-RoFormer 将复数频谱分成非重叠频带，交替执行时间轴和频率轴 Transformer，再估计 complex mask。原论文使用 waveform MAE 与多分辨率 complex STFT MAE；本项目保留这一信号建模方式，不在首版学生中改成纯 waveform 网络。

### 3.2 本机实测

测试设备为 NVIDIA GeForce RTX 3060 Laptop GPU 6 GB，PyTorch 2.11.0+cu130；未安装 Flash Attention 或 Triton。输入为《珊瑚海》上游提取的全部人声，长度 255.467 秒。

| 项目 | 实测值 |
|---|---:|
| 教师模型前向 | 69.15 秒 |
| 可复现整曲 benchmark | 68.89 秒 |
| 模型阶段 RTF | 0.270 |
| CUDA 峰值分配 | 2.17 GB |
| CUDA 峰值保留 | 3.35 GB |
| 模型构造、读权重、上传 GPU | 0.78 秒 |
| Python／依赖导入 | 6.99 秒 |
| 两路 FLAC24 编码 | 0.91 秒 |
| 同进程编码还原校验 | 1.19 秒 |

内部 CUDA event 区间显示，时间 Transformer 约 39.65 秒，频率 Transformer 约 26.37 秒；真正的时间／频率 SDPA 合计约 15.08 秒。其余时间仍包含 QKV、输出投影、RoPE、归一化、FFN 和调度间隙。因此，仅替换 attention kernel 不能解决主要耗时，更不能证明安装 Flash Attention 值得承担 Windows 分发复杂度。

### 3.3 当前推理策略结论

- 整曲 overlap 4→2 将模型阶段从 68.89 秒降至 35.77 秒，但输出相对基线只有 18.58 dB 差分 SNR，必须听感验收，不能作为默认质量档。
- overlap 4→3 为 56.14 秒，差分 SNR 23.32 dB，也不是无损优化。
- 25 秒片段上 batch 1 与 batch 2 速度接近；batch 4 因显存压力反而从约 5.8 秒恶化到约 16.0 秒。
- 10 秒窗口更慢且改变输出；分块补边和窗口数量不能只按理论窗口长度推断。
- 普通 PyTorch 自动 SDPA 与现有路径无收益；等宽频带 Linear 分组化也未获得加速。

降低 overlap 可以作为独立的“快速档”，但它不是模型蒸馏的替代方案。

## 4. 学生模型选型

### 4.1 架构路线比较

| 路线 | 优点 | 主要风险 | 结论 |
|---|---|---|---|
| 缩小的 BS-RoFormer | 与教师共享 STFT、频带、complex mask 和残差契约；最适合输出／mask 蒸馏 | Transformer 仍可能是移动端瓶颈 | **首选** |
| Mel-Band RoFormer | 可借鉴局部时间 attention 研究，社区实现较多 | 更换频带映射后不能直接复用当前配置，变量过多 | 暂不作为首版学生 |
| 频谱 U-Net／ConvNeXt | Conv 算子通常更容易被移动后端优化 | 角色判断和长时身份稳定性要重新学习，无法直接继承教师结构 | 若 7M RoFormer 真机不达标，再做独立对照 |
| Conv-TasNet／纯时域 TCN | 无需网络内 STFT，可做小模型 | 44.1 kHz 立体声长序列代价高，波形伪影和增益稳定性需重新验证 | 非首选 |
| Demucs 类时频混合模型 | 对常规多 stem 分离成熟 | 当前任务只是全部人声内部二分，结构和部署复杂度偏高 | 不纳入首轮 |
| 指定歌手／参考音频模型 | 能表达“我要哪个歌手” | 是另一种产品任务，参考质量和身份切换仍需解决；本轮听感基准已选 becruily | 作为后续独立功能，不与本轮蒸馏混合 |

选择缩小 BS-RoFormer 的核心原因不是假设 Transformer 一定最适合手机，而是先固定教师已验证的信号表示和任务边界，只改变容量。若它在真机仍不达标，再用同一训练／测试数据与卷积学生公平比较。

### 4.2 已构造候选

以下成绩均为当前 GPU、batch 1、4 秒音频、FP16、单次模型前向的 5 次中位数，不含整曲 overlap、IO 和导出后端，也不是手机速度。

| 候选 | 结构 | 参数量 | FP16 权重 | 4 秒前向 | 定位 |
|---|---|---:|---:|---:|---|
| Teacher | 12 层、d256、8×64、FFN×4 | 51.05M | 102.1 MB | 224 ms | 质量教师 |
| Desktop-D6 | 6 层、d256、8×64、FFN×4 | 38.42M | 76.8 MB | 121 ms | 低风险对照／中间教师 |
| **Student-D6-D128** | **6 层、d128、4×32、FFN×2** | **7.07M** | **14.1 MB** | **67 ms** | **首选学生** |
| Student-D4-D128 | 4 层、d128、4×32、FFN×2 | 6.28M | 12.6 MB | 51 ms | 速度／质量对照 |
| Student-D4-D96 | 4 层、d96、3×32、FFN×2 | 4.03M | 8.1 MB | 53 ms | 暂不优先 |

4.03M 候选并未比 6.28M 候选更快，说明小矩阵和调度开销已经明显，不能继续以参数量推断速度。

### 4.3 首选学生

第一版正式训练采用 `Student-D6-D128`：

```yaml
dim: 128
depth: 6
heads: 4
dim_head: 32
mlp_expansion_factor: 2
mask_estimator_depth: 2
stereo: true
num_stems: 1
```

保持教师的：

- 44.1 kHz stereo；
- FFT/hop/window；
- 62 个自定义频带及其边界；
- time/frequency 交替 Transformer；
- RoPE；
- complex mask 输出；
- 主唱预测加残差构造和声的信号契约。

理由：

1. 普通 Linear、MatMul、Softmax、归一化和激活容易在 PyTorch、ONNX/LiteRT/Core ML 中表达。
2. 约 14 MB FP16 权重已接近移动交付目标，继续压缩应以真机速度和音质为依据。
3. 相比 4 层候选，多两层为角色判断、长时上下文和声部交叉保留容量。
4. 训练显存 smoke test 仅约 0.35 GB PyTorch 峰值分配，允许在当前 GPU 上使用更长片段或更大有效 batch。

### 4.4 对照与后续结构

- `Desktop-D6`：可以从教师第 1/3/5/7/9/11 层初始化，适合判断“减层”本身的质量损失，也可在必要时作为中间教师。但其输出头仍占 24.72M 参数，文件过大，不是最终移动模型。
- `Student-D4-D128`：用于判断第 5–6 层的质量价值。只有在盲听和困难分位接近 D6 时才替代首选。
- `Student-D4-D96`：只有在移动设备证明 d96 明显更快或更省内存时继续。
- 局部时间注意力：第二阶段研究。必须真正把序列物理划窗，不能只给完整 `T×T` attention 加 mask。现有 Windowed Sink Attention 论文在另一 RoFormer 任务上证明了方向可行，但其 FlexAttention 实现不应成为 BandBuddy Windows 用户的安装依赖。
- 输出头低秩／共享：第三阶段研究。教师输出头 24.72M 参数，学生 D128 输出头仍有 4.15M 参数，压缩主要减少下载和内存；是否提速必须实测。

## 5. 数据方案

### 5.1 数据分层

训练数据分为三层：

| 层级 | 内容 | 作用 |
|---|---|---|
| A：真实独立轨 | `all_vocals / lead / backing` 对齐真值 | 纠正教师错误，决定最终角色边界 |
| B：真实混音模拟输入 | 对完整 mix 跑 BandBuddy 上游，得到带泄漏的 `estimated_all_vocals`，目标仍是真实 lead/backing | 适配正式流水线 |
| C：用户成品歌曲 | 只有 mix，先提取全部人声，再由 becruily 生成教师伪标签 | 扩展中文流行和真实发行分布 |

训练主输入必须与应用一致。只有多轨数据时，应同时生成：

```text
V_clean = L_gt + B_gt
V_est   = UpstreamSeparator(full_mix)
L_t     = Teacher(V_est)
B_t     = V_est - L_t
```

`V_clean` 用于学习干净的角色边界，`V_est` 用于学习上游泄漏下的鲁棒性。不能只在干净、无伴奏、无混响的独唱数据上训练。

### 5.2 公开数据集

| 数据集 | 可用内容 | 本项目用途 | 许可／注意事项 |
|---|---|---|---|
| **MoisesDB** | 240 首、14:24:46；原始人声轨标注 `Lead Male Singer`、`Lead Female Singer`、`Background Vocals` 等 | **真实轨核心训练**；扫描出同时存在主唱与背景人声的歌曲 | CC BY-NC-SA 4.0；并非每首都有背景人声 |
| **MedleyVox** | 381 段、3956 秒；其中 main-vs-rest 64 段、904 秒 | **困难测试集**，不参与训练 | Zenodo 描述写 CC BY-NC-SA 4.0；源自 23 首 MedleyDB 歌曲 |
| **MedleyDB 1/2** | 196 首；mix、处理后 stems、raw、乐器和旋律排名 | 人工清洗后补充真实轨 | CC BY-NC-SA 4.0；完整音频需申请访问 |
| **Cantoría** | 11 首专业 SATB 四重唱、独立歌手轨、带／不带 organ 混音 | 多声部、音高交叉、角色合成 | CC BY-NC 4.0；古典域偏差明显 |
| **Choral Singing Dataset** | 3 首、16 位歌手独立同步轨、F0／音符标注 | unison、同音 double、弱声部 | 当前版本标记 CC BY-NC 4.0；规模小 |
| **Dagstuhl ChoirSet** | 2 首、13 位歌手、full choir／quartet、多类近讲麦克风 | 串音和强相关人声鲁棒性 | CC BY-NC-SA 4.0；规模小 |
| **PawChorale** | 200 首、master、独立 SATB、MIDI／MusicXML，MP3 | 可选声部预训练，不做核心真值 | 无统一许可证；172 CPDL、3 CC BY-NC、25 标记 public domain，逐作品核验 |

公开数据使用原则：

- MoisesDB 是最直接的数据，但下载后必须先统计真正同时含 `lead` 和 `background` 的有效时长，不能把 14.4 小时都算成成对真值。
- MedleyVox 完整保留为测试。如果使用 MedleyDB 训练，必须排除 MedleyVox 来源的 23 首歌曲，避免测试泄漏。
- MedleyDB 的 stem 编号没有统一角色含义，需结合 metadata、melody ranking 和人工试听建立 `lead/backing` 映射。
- 合唱数据可指定一个声部／歌手为目标、其余为 residual，但这种构造不是流行音乐制作中的真实主唱角色，只能作辅助和困难样本。
- MUSDB18-HQ 只有合并后的 vocals，不提供独立主唱／和声，不作为真实角色监督；可用于上游人声泄漏模拟或普通伪标签。

### 5.3 用户提供的数据

按价值从高到低接收：

1. 同长度、采样对齐的 `lead_vocals`、`backing_vocals`、`all_vocals` 和最终 mix。
2. `all_vocals` 与最终 mix。
3. 普通 WAV／FLAC 成品歌曲。
4. 只有 MP3/AAC 时仍可使用，但应记录编码来源，不能和无损版本跨 split。

第一轮 30–50 首用于验证导入、教师缓存、采样和试听流程。首个可信蒸馏实验建议合计 10–20 小时实际发行风格数据，再根据独立验证曲线决定是否扩大到 100 小时以上。公开数据和用户数据的有效时长应分别报告，不能只报切片数量。

用户数据应优先覆盖中文流行、男女主唱、男女对唱、同一歌手叠唱、密集副歌、弱和声、完全无和声、强混响和 live 风格。普通成品歌曲只能产生教师伪标签，不能被记为真实主唱／和声真值。

### 5.4 数据目录与 manifest

建议每首歌使用不可逆内部 ID，不把歌名作为训练主键：

```text
dataset/
  raw/<source>/<song_id>/
    mix.*
    all_vocals.*
    lead_vocals.*
    backing_vocals.*
  derived/<teacher_revision>/<song_id>/
    estimated_all_vocals.flac
    teacher_lead.flac
    teacher.json
  manifests/
    research-nc.jsonl
    commercial-clean.jsonl
    validation.jsonl
    test.jsonl
```

每条 manifest 至少记录：

```text
song_id, source, rights_class, artist_group, production_group, split,
sample_rate, channels, frames, mix_path, all_vocals_path,
lead_path, backing_path, teacher_lead_path,
source_sha256, teacher_sha256, teacher_revision, qc_state
```

必须维护两个互不混合的数据血缘：

- `research-nc`：允许使用非商业公开集，只产生研究 checkpoint。
- `commercial-clean`：只包含明确允许产品训练和分发的数据，产生候选产品 checkpoint。

任何 checkpoint 都要保存训练 manifest 的内容哈希，避免非商业数据意外进入产品权重。

### 5.5 数据质检

导入时自动检查：

- 44.1 kHz、2 声道，或可确定性转换到该格式；
- 所有轨道长度和起点逐样本对齐；
- 无 NaN/Inf、损坏、空文件或异常 DC；
- 峰值不过载，记录但不擅自分别归一化各 stem；
- 若有真值，验证 `lead + backing ≈ all_vocals`；
- 若 stem 来自 DAW，确认发送效果／混响返回是否属于 lead、backing 或共享总线；
- 检测同一录音的不同编码、remaster、伴奏版，确保不跨 split；
- 对自动角色映射进行人工抽听，并保存审核状态。

所有轨只能施加共同增益。分别归一化主唱和和声会破坏相对响度、残差关系和最终相减契约。

### 5.6 数据划分

- 以歌曲为最小分组；同歌的切片、不同编码和不同教师版本必须在同一 split。
- 尽量以歌手、专辑／制作来源为更高层分组，降低音色和混音风格泄漏。
- 建议起步为 train 80%、validation 10%、test 10%，但 MedleyVox 和专门的用户盲听集始终独立。
- 《珊瑚海》已经参与开发和试听，只能放开发集，不能作为最终测试证据。
- 测试集冻结后不再依据其结果选 checkpoint。

### 5.7 采样与增强

建议按场景分层采样，避免大量独唱／静音切片淹没弱和声：

| 场景 | 初始采样占比 |
|---|---:|
| 主唱与和声同时活动 | 30% |
| 弱和声／远低于主唱 | 15% |
| unison／double／八度 | 15% |
| duet／角色交接 | 10% |
| 主唱独唱、无和声 | 15% |
| 主唱静音、其余声部仍唱 | 10% |
| 纯静音／上游泄漏 | 5% |

这是起步配比，应按数据实际分布和错误分析调整。

安全增强包括：对输入和目标共同施加增益、左右声道互换、轻微声像／宽度扰动、对完整 mix 重新运行上游分离、少量编码／重采样模拟。重新混合 lead/backing 时要覆盖“和声偶尔更响”的情况，防止学生把响度当成角色标签。pitch shift、time stretch、强 EQ 和人工混响只有在输入与所有目标严格一致变换且通过听感后才加入。

## 6. 教师缓存

### 6.1 固定教师版本

教师伪标签必须由固定模型哈希和质量设置产生：

```text
model_sha256 = eb90ee24c1154d83fbcfd27e96182f19e061557cc6e4746953125e08c29389f9
sample_rate  = 44100
channels     = 2
chunk        = 20 s
overlap      = 4
batch        = 2（仅影响执行，不改变契约）
normalize    = false
```

先对完整歌曲运行教师，再从缓存裁剪训练片段。不能对每个 4 秒 crop 单独运行教师，否则教师上下文和正式推理不一致。

### 6.2 缓存内容

至少缓存：

- 教师输入 `V`；
- 教师主唱 `Lt`；
- 元数据、模型哈希、推理参数和输入哈希；
- 若实现允许，额外缓存教师 complex mask 或稳定的复数频谱输出。

教师和声始终即时计算为 `Bt = V - Lt`，不必重复存储。44.1 kHz 立体声 float32 的输入加教师主唱约 2.54 GB/小时；100 小时约 254 GB。实际缓存优先使用共同增益、逐样本可验证的 FLAC24，并保留少量 float32 基准用于导出一致性测试。

### 6.3 伪标签筛选

- 计算活动率、峰值、残差能量和重建误差；
- 对主唱短暂停顿、和声更响、unison、duet 和强混响片段提高人工抽检比例；
- 标记教师明显选错角色、身份中途切换或把和声填入主唱静音区的片段；
- 错误伪标签不直接丢弃：有真值时可用于“教师失败案例”，无真值时降低权重或排除。

## 7. 蒸馏方法

### 7.1 输出级蒸馏优先

第一版只要求学生匹配教师／真值的主唱波形和复数频谱，不先引入大量中间层约束。不同宽度学生的特征维度不一致，过早增加投影层会让损失来源难以解释。

定义：

```text
Ls = Student(V)
Bs = V - Ls
Lt = Teacher(V)
Bt = V - Lt
```

有真值数据时：

```text
L_gt = WaveL1(Ls, L)
     + MRComplexSTFT(Ls, L)
     + 0.5 * EnergyNormalizedSTFT(Bs, B)
     + ActivityPenalty(Ls, L)
```

伪标签或教师辅助时：

```text
L_kd = WaveL1(Ls, Lt)
     + MRComplexSTFT(Ls, Lt)
     + 0.5 * EnergyNormalizedSTFT(Bs, Bt)
     + optional MaskDistillation(Ms, Mt)
```

总损失：

```text
L = lambda_gt * L_gt + lambda_kd * L_kd
```

有真值的 batch 以真实监督为主；纯用户歌曲 batch 才完全依赖 `L_kd`。起步可令 `lambda_gt=1`、`lambda_kd=0.5`，再通过验证集搜索，不把该权重当成固定结论。

### 7.2 损失注意事项

- 不能分别对 `Ls` 与 `Bs` 再加普通 waveform L1 并声称获得两份独立监督。因为 `Bs=V-Ls`、`B=V-L`，两者的 waveform 误差绝对值完全相同，只是重复加权。
- 和声监督通过能量归一化的 log/complex STFT、弱和声重采样、活动损失和真实和声目标实现；静音分母必须有下限。
- SI-SDR 对全局缩放不敏感，不适合作为唯一训练目标。主唱移除依赖正确增益，必须保留 scale-dependent waveform／complex STFT 损失。
- complex mask 蒸馏要按输入频谱能量加权，输入接近零的 bin 不应产生病态梯度。
- 如果只能从后处理波形反推 mask，应设置幅度 floor；更推荐直接从教师前向捕获 mask。
- `Ls + Bs = V` 由结构保证，但仍要在每次导出和整曲推理后做数值重建检查。

### 7.3 训练阶段

#### 阶段 0：数据与实现自检

- 在 1–3 首真实多轨上过拟合，确认角色映射、损失、残差和保存格式正确。
- 训练、保存、重新加载后输出一致；无 NaN/Inf。
- 4 秒 batch 1 的反向传播只作为管线 smoke test。

#### 阶段 1：真实轨监督

- 使用 MoisesDB 筛选集、清洗后的 MedleyDB 和少量合唱辅助集。
- 同时训练 `V_clean` 和 `V_est` 输入。
- 先建立学生的真实角色边界，避免一开始完全复制教师偏差。

#### 阶段 2：教师蒸馏与用户域适配

- 加入用户成品歌曲的完整长上下文教师缓存。
- 真实轨与伪标签 batch 分开采样并报告各自损失。
- 对中文流行、duet、弱和声等不足场景提高采样权重。

#### 阶段 3：长上下文微调

- 从 4 秒 crop 起步，稳定后增加到 8–12 秒。
- 最终 checkpoint 必须用 20 秒正式窗口和完整歌曲验证。
- 如果显存允许，混入少量更长片段；不能只在短片段上判断身份稳定性。

#### 阶段 4：结构压缩对照

- 比较 D6-D128 与 D4-D128。
- 单独验证输出头低秩／共享，不与局部 attention 同一轮改变。
- 局部 attention 从全 attention checkpoint 微调并加入 mask distillation。

#### 阶段 5：量化感知训练

- FP16 学生质量稳定后再进入 INT8/QAT。
- 先做每层敏感度分析；LayerNorm、Softmax、极低能量 mask 路径可保留较高精度。
- weight-only 量化只保证体积下降，不保证执行加速；必须检查目标后端是否真正执行该精度。

### 7.4 初始化与中间教师

D6-D128 的宽度与教师不同，不能像 D6-D256 一样直接逐张量复制。首轮同时保留三条可比较路线：

1. **随机初始化 + 输出蒸馏**：作为最清晰的基线，判断数据和损失本身是否足够。
2. **结构化投影初始化**：对教师 Linear／输出头做 SVD 或通道投影，把 d256 映射到 d128；只作为初始化，随后全量微调。投影误差和最终质量需单独报告。
3. **Teacher → D6-D256 → D6-D128**：先训练 38.42M 中间教师，再蒸馏 7.07M 学生。它可能缓和容量差，但训练成本更高，不预设一定优于直接蒸馏。

三条路线必须使用相同数据、步数和验证集。若中间教师没有稳定改善困难分位或收敛速度，就删除该阶段。不要为了复用教师权重长期保留过大的输出头。

### 7.5 起步训练配置

| 项目 | 建议起点 |
|---|---|
| Optimizer | AdamW |
| 新学生学习率 | 从 `1e-4` 量级搜索 |
| 中间教师／复制层学生 | 使用更小学习率搜索 |
| 精度 | AMP FP16 |
| crop | 4 秒起步，逐步 8–12 秒 |
| batch | 按显存实测；用梯度累积增大有效 batch |
| gradient clip | 1.0 |
| memory | activation checkpointing |
| checkpoint selection | validation 真值指标 + 固定盲听集 |
| reproducibility | 固定 seed、数据 manifest hash、模型／配置 hash |

可以使用 EMA，但要同时保存非 EMA 权重，避免无法归因的质量变化。训练轮数不预先固定，以验证集和过拟合趋势为准。

## 8. 评测与验收

### 8.1 自动指标

真实轨测试集分别报告 lead 和 backing：

- scale-dependent SDR／SNR；
- SI-SDR，仅作为诊断；
- waveform MAE；
- 多分辨率 complex STFT 距离；
- 主唱静音区的错误输出能量；
- 和声静音区的主唱泄漏；
- `lead + backing` 重建最大误差和 SNR；
- 按 unison、duet、弱和声、角色交接、强混响等标签分组；
- 中位数、10/25 分位和最差案例，不只报告全局均值。

教师和学生都要对真实真值评测。学生“更像教师”不等于更正确；真实轨允许学生超过教师。

### 8.2 听感测试

每轮候选生成固定的 10–20 秒片段，随机隐藏名称，分别试听：

- 主唱中的和声残留；
- 和声中的主唱残留；
- 主唱音色、齿音、尾音和混响损伤；
- 弱和声是否被误删；
- 声像漂移和立体声塌缩；
- chunk 接缝；
- 长歌中角色是否切换。

至少包含：MedleyVox main-vs-rest、公开真实多轨、用户中文歌曲和从未参与调参的整曲。结果记录失败标签和偏好，不只记录“听起来不错”。

### 8.3 性能指标

所有平台记录：

- 整曲墙钟时间与 RTF；
- 模型加载、首次推理和热推理；
- 峰值 RAM／VRAM 与 runtime 保留量；
- 片尾补边产生的实际窗口数；
- 模型文件与完整运行库增量；
- Android/iOS 的持续温升、电量和降频；
- 前后处理、STFT、网络、overlap-add、编码各阶段时间。

### 8.4 首轮验收门槛

以下是研发门槛，不代表已经达到：

| 维度 | 首轮门槛 |
|---|---|
| 真值质量 | lead/backing 中位指标相对教师退化不超过 0.5 dB；困难 10% 单列审核 |
| 听感 | 盲听中不出现稳定可识别的新增主唱残留、和声误删或角色切换 |
| 重建 | float32 路径最大误差接近数值精度；编码后满足当前验证协议 |
| Windows 速度 | 同输入、同 20 秒窗口、同 overlap 4，整曲模型阶段至少 2× 教师 |
| 权重 | FP16 约 15 MB 以内 |
| Windows 分发 | 不新增 Flash Attention、Triton、编译器或用户安装步骤 |
| 移动导出 | 固定输入图可转换，输出与 PyTorch 在定义容差内 |

如果质量达标但整曲速度未达到 2×，先剖析学生整曲阶段，再决定是否做 D4、局部 attention 或后端优化，不能直接继续缩模型。

## 9. 推理与部署

### 9.1 统一网络边界

为提高跨平台成功率，移动版本优先把 STFT/iSTFT、padding、overlap-add 和残差放在平台 DSP／原生层，神经网络只处理固定形状的实数张量并输出 complex mask 的实部／虚部。

```text
PCM stereo
  -> native STFT / band preparation
  -> fixed-shape Student network
  -> complex mask
  -> native iSTFT / overlap-add
  -> lead
  -> backing = input - lead
```

必须逐帧验证 Hann window、center/padding、幅度归一化、频带顺序、声道顺序和裁剪长度。网络导出一致并不自动证明整条音频链一致。

### 9.2 Windows

第一版继续使用 BandBuddy 自带的 PyTorch/CUDA 环境和普通算子：

- 不安装 Flash Attention；
- 模型在应用 worker 内按现有哈希和 revision 管理；
- FP16 autocast，batch 根据可用显存选择，不能仅按 GPU 型号写死；
- batch 1 作为低显存安全档，batch 2 只有实测更快时启用；
- overlap 4 为质量基准，快速档必须单独标识并经试听确认；
- 模型常驻只优化约 0.8 秒加载，不应掩盖 69 秒前向主瓶颈。

后续可评估 ONNX Runtime CUDA／DirectML，但只有在完整安装包、冷启动和不同 GPU 上证明收益后才替换当前路径。

### 9.3 Android

候选路径：

1. LiteRT 的 PyTorch 转换路径；
2. ONNX Runtime Mobile CPU／GPU；
3. Snapdragon 设备上的 QNN HTP。

模型必须使用固定 batch 和固定时间维度。QNN HTP 要求量化模型且不支持动态形状，因此不能把动态整曲图直接交给 NPU。QNN 只覆盖 Qualcomm 设备，不能作为全部 Android 的唯一后端；CPU 路径仍是兼容回退。

首版移动导出先验证 FP16／FP32，再做 QAT。开发阶段可以使用转换工具链，但用户安装包不携带 Python、QNN SDK 或编译器。

### 9.4 iOS

在 macOS 构建机使用 Core ML Tools 捕获固定 PyTorch 图并转换为 ML Program。先对 CPU/GPU/ANE 分别确认：

- 图是否完整落到目标计算单元；
- 是否因不支持的 reshape、复数算子或动态形状回落；
- FP16 输出和 PyTorch 的逐层／最终误差；
- 20 秒或移动短窗口的峰值内存和持续温升。

STFT 放在网络外可以减少 Core ML 对复数 FFT 和动态音频长度的依赖。只有真机执行证明收益后才使用 palettization、linear quantization 或剪枝。

### 9.5 INT8/QAT

- 训练后静态量化用于建立速度／质量下界；音质不稳定时切换 QAT。
- ONNX 优先导出标准 QDQ 表达，便于后端识别量化节点。
- 为校准集保留真实弱和声、静音、强混响、unison 和上游泄漏片段；随机普通片段不足以校准极低能量输出。
- 单独报告权重体积、网络耗时和整曲耗时。INT8 文件更小但如果频繁反量化或回落 CPU，整曲可能更慢。

## 10. 实验矩阵与决策顺序

严格一次只改变一个主要因素：

| 顺序 | 实验 | 决策 |
|---:|---|---|
| 1 | D6-D128，真实轨监督 | 学生是否能学会角色边界 |
| 2 | 加教师 KD | 是否改善中文／真实发行域且不放大教师错误 |
| 3 | D4-D128 | 两层容量是否值得速度成本 |
| 4 | 更长 crop／正式整曲 | 是否减少身份切换和接缝 |
| 5 | 输出头低秩／共享 | 文件大小下降是否伴随可接受音质和真实速度收益 |
| 6 | 物理局部 attention | Transformer 墙钟是否显著下降 |
| 7 | FP16 导出 | 跨后端数值和听感一致性 |
| 8 | INT8 PTQ/QAT | 真机是否真正加速且弱和声不被量化吞掉 |

每个实验保存配置、git revision、数据 manifest hash、checkpoint hash、训练曲线、自动评测、整曲 benchmark 和试听清单。

## 11. 已排除或低优先级方向

- **为 Windows 普遍安装 Flash Attention**：当前环境没有可用 Flash kernel，且即使理想化完全消除约 15 秒 SDPA，69 秒前向的理论上界也仅约 1.28×，不足以解决全部 Transformer 开销。
- **无结构剪枝／只置零**：普通 dense kernel 仍计算原矩阵，通常不产生真实加速。
- **单纯减参数**：输出头参数多但前向时间少；4M 模型未比 6M 模型更快。
- **盲目扩大 batch**：6 GB GPU 上 batch 4 已出现严重显存压力和减速。
- **缩短窗口即加速**：10 秒窗口因窗口数和补边规则反而更慢。
- **仅降低 overlap**：可以大幅加速，但输出变化明显，是质量档选择，不是蒸馏。
- **只用教师伪标签**：会继承角色误选、主唱静音区填充和身份切换，必须用真实轨校正。
- **只用 SI-SDR**：不能保证相减所需的绝对增益。

## 12. 许可与发布门槛

### 12.1 教师权重

becruily Hugging Face 仓库当前没有 model card，也没有明确展示权重许可。基础实现或论文的许可证不能自动推导出 checkpoint 的蒸馏、再分发或商业使用权。

在公开或商业发布学生权重前必须确认：

- 是否允许以该 checkpoint 为教师训练衍生模型；
- 是否允许商业使用；
- 是否允许重新分发学生权重；
- 是否有署名、同许可或训练数据方面的附加要求。

未确认前，所有蒸馏权重均标记为内部研发产物。

### 12.2 数据集

MoisesDB、MedleyDB、MedleyVox、Cantoría、Choral Singing Dataset、Dagstuhl ChoirSet 均应按非商业或更严格条件管理，不能默认进入商业产品训练。PawChorale 按作品管理许可，不能用统一标签覆盖。

训练得到的权重是否构成受许可约束的衍生物在不同法域和许可解释下可能存在不确定性。产品分支应只使用明确具有训练和商业发布权的数据，并在发布前完成法律审查或取得书面授权。

用户拥有音乐文件副本不等于拥有模型训练和商业再分发权。每批用户数据都要记录来源、授权主体、允许用途和保留期限。

## 13. 实施阶段与产物

### 阶段 A：数据落地

- MoisesDB／MedleyDB importer 和角色映射；
- MedleyVox 冻结测试集；
- 用户文件导入、去重和 rights manifest；
- 上游 `estimated_all_vocals` 与教师缓存生成器；
- 数据覆盖和 QC 报告。

### 阶段 B：7M 学生基线

- D6-D128 正式模型配置；
- 训练脚本、断点、EMA、日志和可复现 manifest；
- 真实轨监督、KD 和分层 sampler；
- 整曲推理与试听产物。

### 阶段 C：Windows 验收

- 与原教师同设置的整曲 benchmark；
- RTX 3060 Laptop 6 GB 以及至少一台不同 NVIDIA GPU；
- 低显存 batch 1 回退；
- BandBuddy worker 集成、哈希、取消、崩溃恢复和编码校验；
- 安装包启动及无 Flash Attention 环境验证。

### 阶段 D：移动导出

- 固定形状 network-only 图；
- Android LiteRT／ONNX 原型；
- iOS Core ML 原型；
- PyTorch、导出图和真机逐层／最终一致性报告；
- 完整歌曲内存、温升、电量和 RTF。

### 阶段 E：二次压缩

- D4、局部 attention、输出头低秩的单变量实验；
- INT8 PTQ 与 QAT；
- 依据真机数据选择桌面和移动是否共用同一 checkpoint。

## 14. 当前复现入口

本地研究说明和原始结果：

- `experiments/becruily/README.md`
- `output/becruily-20261114/stages/profile.json`
- `output/becruily-20261114/full/benchmark.json`
- `output/becruily-20261114/students.json`
- `output/becruily-20261114/pipeline-io/results.json`

现有 smoke／benchmark：

```powershell
$py = "$env:LOCALAPPDATA\BandBuddy\envs\env\Scripts\python.exe"
& $py experiments/becruily/profile_stages.py
& $py experiments/becruily/benchmark.py `
  --input output/singer-informed-20261114/source/vocals.wav `
  --output output/becruily-20261114/full `
  --variants baseline-b2-t8 overlap3-b2 overlap2-b2 `
  --repeats 1 --short-warmup
& $py experiments/becruily/students.py
& $py experiments/becruily/pipeline_io.py
& $py experiments/becruily/make_report.py
```

这些脚本只证明当前教师剖析、候选大小和少量反向传播可运行；正式训练器、公开数据 importer、冻结测试集、移动导出和可发布学生权重仍未实现。

## 15. 参考资料

- [BS-RoFormer 论文：Music Source Separation with Band-Split RoPE Transformer](https://arxiv.org/html/2309.02612)
- [becruily 模型仓库](https://huggingface.co/becruily/bs-roformer-karaoke)
- [becruily 官方配置](https://huggingface.co/becruily/bs-roformer-karaoke/blob/main/config_karaoke_frazer_becruily.yaml)
- [Windowed Sink Attention 论文](https://arxiv.org/html/2510.25745v1)
- [MoisesDB 论文](https://arxiv.org/html/2307.15913)
- [MoisesDB 官方仓库](https://github.com/moises-ai/moises-db)
- [MedleyVox 论文](https://arxiv.org/html/2211.07302)
- [MedleyVox 数据](https://zenodo.org/records/7984549)
- [MedleyDB 数据说明](https://medleydb.weebly.com/description.html)
- [MedleyDB 下载与许可](https://medleydb.weebly.com/downloads.html)
- [Cantoría Dataset](https://zenodo.org/records/5878677)
- [Choral Singing Dataset](https://zenodo.org/records/2649950)
- [Dagstuhl ChoirSet](https://zenodo.org/records/4608395)
- [PawChorale](https://pawchorale.github.io/)
- [PawChorale 逐作品权利说明](https://github.com/PawChorale/pawchorale.github.io/blob/main/rights/DATASET_RIGHTS_NOTICE.md)
- [Apple Core ML Tools：PyTorch 转换](https://apple.github.io/coremltools/docs-guides/source/convert-pytorch-workflow.html)
- [Google LiteRT：PyTorch 转换](https://developers.google.com/edge/litert/conversion/pytorch/overview)
- [ONNX Runtime QNN Execution Provider](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)
- [ONNX Runtime 量化](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
