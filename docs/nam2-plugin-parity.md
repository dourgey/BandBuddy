# NAM A2 与本机 TONE3000 插件的数值对照

2026-10-16，Windows x64。实际加载本机安装的 TONE3000 VST3 0.0.12，将同一份双声道浮点 WAV 分别送入插件和 BandBuddy 内置 NAM 效果，再逐采样比较输出。这里的 NAM2 指 NAM A2 的 `SlimmableContainer` 模型。

参考插件路径：`C:\Program Files\Common Files\VST3\TONE3000.vst3`。实际 DLL 的 SHA-256 为 `3649e5b15fc136755cc319ffbac6b3d398435e325e77d59ab287bc6d34e83f6d`。

## 修复的问题

- 模型核心版本相同，外围信号处理不同。BandBuddy 与 [TONE3000 v0.0.12](https://github.com/tone-3000/tone3000-plugin/tree/v0.0.12) 都固定 NAM Core `1f42f88535884450104b8711d7595019afa0495b`，没有发现需要改模型权重或模型推理算法的问题。
- 官方插件在链输出处使用 5 Hz 一阶直流滤波。原先 BandBuddy 缺少该滤波，48 kHz 下即使不涉及重采样也有可测差异。现在使用相同的 float 系数和滤波形式；模块链只在总输出滤波一次，旁通渐变后保持干声。
- 非 48 kHz 时，原先使用自定义 sinc 重采样，且把 NAM 转换延迟固定写成 64 帧。现在使用官方同版本 AudioDSPTools 的 `ResamplingContainer<float, 2, 12>` Lanczos 边界，在准备阶段测量实际延迟，再用于导出补偿。48 kHz 不经过该边界。
- 输入校准、模型输入增益及归一化增益放在模型采样率内处理，避免将它们移过重采样边界。归一化与官方一致：目标 -18 dB、调整限制在 ±12 dB；缺失或不可信的 loudness 元数据按单位增益处理。
- 模型先 `ResetAndPrewarm`，再选 Full/Lite，与官方初始化顺序相同。

以上行为核对自官方 [Processor.cpp](https://github.com/tone-3000/tone3000-plugin/blob/v0.0.12/plugin/src/Processor.cpp)。上游头文件没有修改，相关许可随原生运行时安装在 `licenses/AudioDSPTools-NOTICES.txt`。

## 对照条件

三份真实模型来自该版本官方仓库的 `test/files`，只在本机测试，未加入产品资源或提交为测试夹具。

| 模型 | SHA-256 |
| --- | --- |
| `a2-amp-test.nam` | `0c09c293df07f6e0871b4215f6bfc788f57509bf08b0b5a5ed2bbac04fc70967` |
| `a2-amp-cab-test.nam` | `1ccdfb64bc561260d4278d203b217c7c6c4e97a2a62f4d436b3338bfe324b977` |
| `a2-am-test-2.nam` | `a978675435e6bbb5681212d7f0a9f3f02a8701f7bf3fa8ebf66717ae2cff3970` |

基础矩阵为三份模型 × 44.1/48/96 kHz × Full/Lite × Raw/Normalized，共 36 组。另对带输入校准元数据的 Marshall 模型使用 12 dBu 接口参考值验证 6 组；修改一份测试副本的 loudness 为 -40 dB，验证归一化 +12 dB 上限的两档质量，共 2 组。修改元数据的副本不算新增真实模型。

统一条件：双声道 dual mono，整体输入/输出与模型块输入/输出均为 0 dB；Mix 为 100%；关闭独立 IR、门限、EQ、音高、Spread 和 oversampling。模型自带的箱体响应保留。输入包括拨弦衰减、谐波、瞬态和固定种子噪声，左右声道不同。每份输入 6 秒，前后各 1 秒静音。

插件通过独立 Plugin Worker 和共享内存桥按真实时间运行，等待异步模型加载，再发送音频。每组要求非静音、全部采样有限、桥接无丢块、Worker 无故障。用 1.2–4.9 秒窗口计算相对 RMS 和最大绝对采样差。仅使用插件/宿主公开的延迟补偿，没有搜索最佳时间差、拟合增益、或对输出文件重新归一化。WASM 用 257 帧回调，跨越内部 128 帧处理边界。

BandBuddy 的默认 Full、Raw、总输出 -6 dB，与 TONE3000 的默认设置并不相同。手动 A/B 时必须先对齐这些设置；默认音量或质量不同不代表模型推理失真。

## 结果与本地证据

44 组实际插件对照全部通过。除主要的 1.2–4.9 秒窗口外，又对完整有声输入 1–5 秒逐采样核验了全部 44 组，结果如下：

| 路径 | 最大相对 RMS 误差 | 最大绝对采样差 | 逐采样相同的组数 |
| --- | ---: | ---: | ---: |
| 原生 | `7.5652e-7`，约 0.0000757% | `1.3113e-6` | 36 / 44 |
| WASM | `5.1012e-6`，约 0.0005101% | `2.6170e-5` | 18 / 44 |

原生的 18 组 Raw 全部逐采样相同，6 组输入校准也全部逐采样相同。余下原生差异只出现在第三份模型的归一化及 +12 dB 上限用例；官方用 float 计算元数据增益，而应用层用 JavaScript number 再转换成 float，存在舍入差异。Full 模型的 WASM 与原生在同一 NAM Core 下也有微小差异；结合 Raw 原生与官方完全相同的结果，判断这来自编译目标的浮点计算精度，而不是缺失滤波或错误重采样。这里按实际误差报告等价性，未声称所有路径都逐位相同。

最终取用的插件音频均要求零丢块、零无效采样、零 Worker 故障。一次 96 kHz 用例在探针记录的约 6.9 ms 回调迟到期间出现 2 块桥接超时，未计入通过结果。保留失败记录并重新核验前 34 组音频，随后重试未完成项，通过；详见主报告的 `previousFailures`。这不构成长时间实时性能认证。

修复前，采用相同公开延迟补偿，首份真实模型的相对 RMS 差异为：

| 采样率 / 质量 / 模式 | 修复前相对 RMS | 最大采样差 |
| --- | ---: | ---: |
| 48 kHz / Full / Raw | 2.5602% | 0.0234858 |
| 48 kHz / Lite / Raw | 2.5510% | 0.0221485 |
| 44.1 kHz / Full / Raw | 4.3936% | 0.1432254 |

最终构建的逐组结果、插件和运行时哈希、输入/模型哈希均保存在以下本地报告中：

- [36 组基础矩阵](../output/nam2-parity-20261016/report.json)
- [6 组输入校准](../output/nam2-parity-20261016-calibrated/report.json)
- [2 组归一化上限](../output/nam2-parity-20261016-normalization/report.json)
- [修复前对照](../output/nam2-parity-20261016/before/report.json)
- [汇总与本地运行时哈希](../output/nam2-parity-20261016/summary.json)
- [完整有声输入窗口核验](../output/nam2-parity-20261016/full-active-window.json)

每组目录保留 `input.wav`、`bandbuddy-native.wav`、`bandbuddy-wasm.wav`、`tone3000.wav` 和 `difference.wav`。`tone3000.wav` 保留实时桥接延迟；`difference.wav` 是补偿该延迟后原生输出减去插件输出。WASM 和原生导出已经移除各自公开的 DSP 延迟。数值门限为相对 RMS < `1e-4` 且最大采样差 < `1e-4`；各组实际误差见 JSON。

原生和 WASM 均已重编译，新的 audio-host / Plugin Worker 及许可已安装到工作区的 `resources/audio-host/win32-x64`；文件哈希与实际对照的二进制一致。6 个相关测试文件共 39 项通过，外部真实模型导入项也实际执行。`node scripts/test-nam.mjs` 的容器子模型选择、分块一致性、原生/WASM、44.1 kHz 处理和 WAV 导出均通过。原生宿主模拟检查和 `pnpm build`（含两套 TypeScript 检查、资源验证、主进程/预加载/渲染构建及构建后运行时检查）通过；模拟检查中的 XRUN 是刻意注入的测试条件。

## 复验

先构建原生运行时及 WASM。Windows 原生测试还需配置 `BANDBUDDY_AUDIO_CORE_TESTS=ON`，以生成实时桥接探针。此脚本固定检查参考插件版本为 0.0.12；插件升级时应先核对状态格式及 DSP 行为。

```powershell
pnpm native:audio
cmake -S native/audio-host -B native/audio-host/build/win32-x64 -DBANDBUDDY_AUDIO_CORE_TESTS=ON
cmake --build native/audio-host/build/win32-x64 --config Release --target bandbuddy-audio-core-tests
pnpm build:effects:wasm
pnpm exec vitest run tests/nam-dsp-native.test.ts tests/arsenal-import.test.ts tests/arsenal-modular-native.test.ts tests/arsenal-whitebox.test.ts tests/arsenal-classic.test.ts tests/arsenal-workstation.test.ts --maxWorkers=2
node scripts/test-nam.mjs C:/captures/amp.nam
node scripts/test-nam-plugin.mjs --model C:/captures/amp.nam --out output/nam-parity
node scripts/test-nam-plugin.mjs --model C:/captures/calibrated-amp.nam --modes normalized --calibration 12 --out output/nam-parity-calibrated
```

默认矩阵不下载任何模型，也不打开音频设备。状态适配器仅配置被实际加载的官方二进制，不复制或模拟其 DSP。未安装参考插件的普通测试仍能运行自造 Linear 容器的直流、旁通、多模块和延迟补偿回归。

长矩阵可用原命令加 `--resume` 继续。脚本必须核对插件/原生/WASM/Worker 哈希和设置，并重新计算已保留音频的数值结果，才会跳过已完成项；失败记录保留在 `previousFailures`。

本次结论限于上述单 NAM 模型、静态参数和对齐设置的数字处理。没有验证任意多模块链与 TONE3000 整链的等价性、额外 IR/EQ/oversampling、声卡往返延迟或盲听；没有重新打包安装版。WASM 数值对照通过 Node 加载同一 WASM 构建完成，不等于实际浏览器音频链路验收。
