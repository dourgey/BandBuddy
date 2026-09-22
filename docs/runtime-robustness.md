# 运行环境与设备兼容性优化

本轮保留既有六轨分离、三个吉他质量档位、录音和效果器功能。模型、重叠比例、TTA 次数和输出采样率不因低配置而降低；内存不足时调整批量，原有 CPU 回退仍有效。

## 安装与恢复

- 新环境在 `runtimeRoot/runtimes/runtime-<UUID>` 创建，通过依赖、ONNX CPU 执行和六轨短推理自检后才切换 `active-environment.json`。失败或取消保留此前环境；虚拟环境目录不重命名。
- 数据目录迁移先复制并校验，再提交设置；旧文件保留。Python 环境继续通过受限指针引用原绝对路径，避免移动 venv 后失效。更换磁盘后要使用旧环境，旧磁盘仍需连接；在新目录修复环境后可解除这项依赖。
- 迁移暂停会写入数据目录的操作，并检查复制期间是否发生外部新增、删除或修改。提交失败时只回滚本次创建的内容和仍由本次迁移拥有的环境指针。
- 安装、子进程、网络读取、系统探测有时间限制。取消等待进程及其管道关闭，POSIX 结束进程组，Windows 结束进程树。输出有界保留，并连续解码 UTF-8。
- 应用退出先等待恢复任务和录音保存，再关闭安装、分轨、分析线程与其解码子进程，随后刷新日志并关闭数据库；退出过程中不再启动队列中的下一任务。

## 联网安装

- 不提供离线资源包。Electron 下载、uv、Python 使用统一的手动、系统或直连代理策略；显式直连清除大小写代理变量。
- 系统 PAC 经只监听本机且需要随机认证的 CONNECT 桥接，按实际请求域名解析；TLS 数据直接透传。支持 HTTP/HTTPS 代理及 PAC 明示的 DIRECT 回退。SOCKS-only 系统配置会明确失败，需使用 HTTP 代理入口。
- 仅在已知国内源预设失败时尝试官方源；不自动拼接任意镜像。uv 下载校验哈希，Windows 重签名工具还需与有效应用签名属于同一证书。模型继续固定已有仓库、版本、大小与哈希，支持续传。
- 安装进度、错误和日志中的代理凭据会脱敏。未在本机验证企业代理的集成认证或特定网络的 PAC 行为。

## Intel Mac 发布要求

- 候选支持范围为 macOS 13 及以上、x86_64、Python 3.12、CPU 完整功能。使用官方 Torch / torchaudio 2.2.2、NumPy 1.26.4、Demucs 4.1.0、ONNX Runtime 1.23.2、librosa 0.11.0、numba 0.61.2 / llvmlite 0.44.0；完整入口见 `python/runtime/macos-x64.in`。
- 不自行编译 Torch。缺失的 sphn 0.1.12 Intel wheel 在原生 Intel CI 构建；纯 Python 源码依赖也仅在 CI 转为 wheel。用户端只安装 wheel。
- Intel CI 使用独立测试依赖，避免误装仅面向较新架构的 Torch 2.11 / NumPy 2.5；这组源码测试不代替完整运行环境验收。较新 macOS runner 选中最低系统版本高于 13 的依赖 wheel 时，仅从原含哈希锁重新下载同版本、兼容 macOS 13 的官方 wheel；无兼容 wheel 则失败。打包门禁也检查最终锁中每个 wheel 的平台标签，不能以 macOS 15 runner 的成功代替 macOS 13 真机测试。
- `resources/runtime-wheels.json` 必须包含真实 sphn URL 与 SHA-256，`runtime-locks/macos-x64.lock` 必须逐项引用同一可信发布位置的 wheel 并含哈希。安装器使用 `--require-hashes`；缺清单或锁会明确拒绝，不能将空清单当成可发行的 Intel 安装包。
- 发布前使用 `worker.py ensure-model --model-root <目录>` 准备资源，然后运行 `worker.py probe --model-root <目录> --full-self-test --device cpu`。验收结果要求六轨、ONNX CPU 和 `fast / balanced / high` 全部成功，再验证原生录放音、效果器及中文路径。
- 当前机器为 Apple Silicon；其通过不代表 Intel 已通过。Intel wheel 真实构建、macOS 最低版本及打包后的端到端验收属于发布门禁。
- 默认标签发行保留 Windows x64 和 Apple Silicon。仓库变量 `ENABLE_INTEL_MAC_RELEASE=true` 显式启用 Intel；启用前不生成、公开或宣称 Intel 包，启用后完整证据缺失、依赖不匹配或任一架构失败都会阻止公开发行。普通 macOS CI 保留 Intel 原生源码测试，未启用时明确跳过 Intel 打包。
- 上游约束：PyTorch 官方将 [2.2.x 作为 macOS x64 的最后支持系列](https://pytorch.org/blog/pytorch2-2/)；Intel CI 使用 [GitHub 官方列出的 `macos-15-intel` 原生 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。runner 可用不等于 macOS 13 真机验收已经完成。

### CPU 输出参考协议

`python/runtime/cpu-comparison-policy.json` 固定协议 `bandbuddy-cpu-output-v1`：1 秒、44.1 kHz、双声道 float32 输入，由整数相位三角波与 LCG 生成；种子为 `20260922`，CPU / BLAS 线程数为 2，Torch interop 为 1，开启确定性算法并固定每个质量档位的种子。输入 SHA-256 为 `93dfefe3a63fdf0bda67ef8054463cfd6b71e29eb50a1c234b010f94eb1944e9`。模型和配置清单仍使用现有固定哈希，真实运行前完整校验。生产代码集合包括两个 worker 入口和吉他流水线的非测试 Python 文件；Python 验收与 Node 打包门禁各自重算同一个规范化 SHA，代码变化后不能复用旧证据。

比较覆盖六个主分轨，以及 fast / balanced / high 各三个吉他输出，共 15 轨。每轨必须同时满足 `maxAbs <= 1e-4`、`RMSE <= 1e-5`、`relativeL2 <= 1e-3`；相对误差分母为参考 RMS，最低取 `1e-7`。报告保留逐轨误差与参考、候选 PCM 哈希。阈值在首次实测前固定，数值失败保存报告并阻止生成正式验收证据；不自动放宽阈值。

使用已通过现有 CPU 功能验收的 Python 环境导出参考，再在候选 Intel 环境比较：

```sh
"/path/to/baseline/python" scripts/runtime-cpu-reference.py export \
  --model-root "/path/to/models" \
  --reference out/cpu-reference/reference.zip \
  --pin out/cpu-reference/cpu-reference.json
"/path/to/intel/python" scripts/runtime-cpu-reference.py compare \
  --model-root "/path/to/models" \
  --reference out/cpu-reference/reference.zip \
  --pin python/runtime/cpu-reference.json \
  --report out/macos-x64-cpu-comparison.json
```

导出拒绝覆盖已有参考。参考 ZIP 包含输入、15 轨波形及带逐文件哈希的清单；pin 绑定 ZIP、策略、输入、模型清单、生产代码与参考环境。参考候选必须先审查，然后才可将 pin 提交到 `python/runtime/cpu-reference.json`，并作为指定的同仓库 CI artifact 输入给 Intel wheel 工作流。该工作流先校验真实参考，再在新建的 Intel 完整 wheel 环境中运行全部模型和数值比较；缺参考、比较失败或版本不符时明确 `INTEL_RELEASE_BLOCKED`。工作流只上传供审查产物，不自动公开发行。

2026-09-22 本机已使用 Apple Silicon CPU、Torch / torchaudio 2.11.0、Demucs 4.1.0、ONNX Runtime 1.28.0 导出真实参考，并独立重复推理一次。15 轨的三个误差指标均为零，PCM 哈希逐轨相同。候选保存在 `out/cpu-reference-arm64/reference.zip`，SHA-256 为 `a95fdff69e25abb894f167915c50e631e6e82d4447e40589328272f806ff3b14`；同目录有 pin 和 `repeat-comparison.json`。它们未上传或发布，正式 pin 仍缺失，因此 Intel 发行仍关闭。该结果仅证明同机 CPU 的可重复性；尚未执行 Torch 2.2.2 Intel 对比，不能据此宣布跨平台数值兼容或听感等价。1 秒合成样本也不替代长音频和真实曲目的质量验收。

## 资源与验证范围

- 启动状态读取短期、版本匹配的健康缓存及模型大小，不在每次打开窗口时完整哈希全部模型。安装和实际分轨仍校验模型完整性。
- Python / BLAS / ONNX 线程预算统一；CUDA 批量按当前可用显存选择，遇到显存不足先减小批量。大型累积缓冲和已经解码的音频使用磁盘映射及分块读取，减少整首音频的常驻内存。上游 Demucs、TTA 与部分统计步骤仍有内存分配，不能承诺任意长度音频或任意低内存机器都可运行。
- 本机验证包含连续 UTF-8、取消与超时、代理域名路由与认证、依赖锁来源、安装准备失败、目录迁移与回滚、健康探测、磁盘映射采样一致性、显存批量决策，以及中文/空格/括号/emoji 路径下的原生音频模拟。
- 原生测试使用模拟设备；Windows DLL/驱动、真实声卡拔插、Intel 原生执行、低内存/低磁盘与不同国内网络组合仍需相应设备和 CI 验证。

### 本机验收记录

- `pnpm typecheck` 通过；环境、传输与迁移的 11 组 TypeScript 测试共 45 例通过。
- Python worker 14 例、吉他流水线 9 例通过；ONNX 小图在真实 CPU provider 执行。
- Apple Silicon 原生音频重新编译通过，`test-audio-host.mjs` 的中文及特殊字符路径模拟通过。
- Apple Silicon 上以 CPU 实际运行全部固定模型：六轨、极速、均衡、精细全部成功，输出形状与有限数值校验通过。测试环境为 Python 3.12.13、Torch 2.11.0、Demucs 4.1.0、ONNX Runtime 1.28.0；这不是 Intel 锁依赖验收。
- 该机器一次健康缓存命中的 `probe --quick` 测得 63.5 ms（含启动 Python 子进程）；这是状态探测耗时，不是整款应用启动时间。
- 集成复核增加退出等待、分析队列清理和 LAN 主题 SSE / HTML CSP 测试；相关 5 组共 19 例通过。LAN 仅公开主题、密度与效果三个白名单字段，错误令牌和跨来源请求被拒绝。
- CPU 参考与发行收尾验证：2 组 TypeScript 门禁测试共 26 例通过，覆盖失效参考、推理代码变化、数值超阈值、缺轨、篡改报告、Intel 显式启用及 macOS 最低版本；新增 Python 参考和 wheel 选择测试共 9 例通过。真实 CPU 两次推理的结果见上述参考记录，合成测试夹具从未写入正式参考或发行清单。
