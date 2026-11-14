# 藏经阁实现与验收记录

日期：2026-11-06。范围：桌面 BandBuddy。当前工作区包含其他既有修改；本记录不代表整个工作区通过发布验收。

## 已完成的验证

| 检查 | 结果与范围 |
| --- | --- |
| 类型检查、生产构建 | `pnpm build` 通过，含资源、记谱资源、主进程/预加载与 AudioWorklet 构建检查；仍有大体积前端 chunk 的构建提示 |
| 转谱相关 TypeScript 回归 | 5 个测试文件、22 项通过：`scores`、`scores-offline`、`job-state`、`jobs-shutdown`、`audio-session` |
| Python 音符/记谱/适配层 | 18 项通过，包含 W3C MusicXML 4.0 XSD 校验；真实模型事件以模拟流验证，未加载 Muscriptor 权重 |
| Windows CPU Python 依赖 | 使用 SHA-256 锁实际安装独立环境，Torch 2.11.0+cpu、Muscriptor、Beat This、mido 等导入通过 |
| 资源固定与打包 | Muscriptor 原始 28 个文件、3 个权重元数据、5 份平台依赖锁校验通过；Windows x64 目录包构建与启动通过，39 个转谱相关包内文件与源码哈希一致 |
| 浏览器工作台 | 谱库、卷帘、独奏、播放、变速、AB、后台播放、五线谱、TAB、翻页、记谱设置、来源选择及下载操作通过；无页面/控制台错误 |
| 超过 16 轨的播放 | 20 条独立吉他轨分配到 32 通道池，音色相同但轨道独立；长音跳转后仍有输出，独奏轨静音生效，3 倍速的 200 ms 墙钟推进约 608 ms，AB 连续循环 4 次；暂停时钟稳定，重叠加载与带前后休止的 1 秒 AB 区间通过 |
| Windows 包内离线工作流 | 隔离数据目录，渲染器设为离线并重新加载应用；真实 preload/IPC、目录包内 Python 后处理、OSMD、AudioWorklet、本地 SF3 全链路运行通过；重新记谱为 100 BPM/三连网格后原始秒值和上一成功版本保留，无页面/控制台错误 |

Python 用例覆盖同音色独立端口、弱起、变速、跨 5 秒与跨小节长音、复合拍号/三连音、多声部/和弦/休止、钢琴双谱表、鼓谱、吉他八度记谱、TAB 占弦/持续音/Drop D/五弦贝斯、异常输入、空结果以及记谱失败后 MIDI 保留。重新生成会清除上一版排版或指法错误提示，保留原始推理提示。

任务测试覆盖来源快照、删除原歌曲后的独立性、串行调度、实时音频启动互斥、转谱环境独立解锁、中断恢复、取消/重试、旧失败任务与新任务隔离、失败保留旧结果、完成后切换版本及真实 Python 重新记谱。

浏览器和 Windows 验收使用明确标注的原创合成音符，不是 Muscriptor 对真实歌曲的识别结果。音频输出通过 Web Audio 分析器验证存在非零 PCM；不是声卡人工听音验收。

## 全量测试的剩余失败

全量 Vitest 首次结果：1122 通过、4 失败、3 跳过。针对 4 个失败文件单独复跑：17 通过、3 失败；`woodshed-notation-layout.test.tsx` 的首次超时复跑通过。其余仍失败的断言为：

- `library-card-overflow.test.tsx`：长标题查找命中多个元素。
- `playback-controls.test.tsx`：查找不到名称为 `M` 的按钮。
- `runtime-preparation-ui.test.tsx`：查找不到“一键准备分轨环境”入口。

这些失败涉及现有曲库/播放器/分离环境 UI；本次没有修改对应断言以掩盖失败。以上全量结果早于新增的离线回归测试；最后的相关回归 22 项全部通过。不能将本次结果表述为全量测试全绿。

## 尚未完成的模型与平台验收

- 本机没有获授权的 Muscriptor small / medium / large 权重。没有真实转谱精度、漏音/误音、耗时或峰值内存/显存基线；没有用合成演示数据代替这些指标。
- 已提供 `scripts/benchmark-scores.py`，支持授权样本清单、权重校验、耗时/内存指标及带参考标注的 P/R/F1。钢琴、吉他/贝斯、鼓、人声、失真合奏和变速样本仍需逐类运行。
- Hugging Face 首次授权、真实大模型下载中断与恢复、权重导入及模型离线推理尚未用真实权重走完。
- Windows CUDA、macOS ARM MPS、macOS Intel CPU 未实机验证；平台依赖锁存在不代表平台推理验收通过。
- Windows 目录包为 `NotSigned`，未生成正式安装器或发布。用户声卡、实际输出设备切换及完整长歌曲的人工听谱验收待做。

## 本机验收产物

临时验收目录：`C:\Users\zhaoj\AppData\Local\Temp\bandbuddy-score-qa`。

- `build.log`、`package-final.log`：生产构建和 Windows 目录包日志。
- `vitest-full.log`、`vitest-existing-failures.log`：全量测试及失败复跑记录。
- `browser-console.json`、`audio-verification.json`：浏览器与 20 轨播放结果。
- `packaged-verification.json`、`packaged-smoke.log`：隔离 Windows 运行结果。
- `scores-roll.png`、`scores-tab.png`、`scores-packaged-tab.png`：界面截图。
- `package-final/win-unpacked/BandBuddy.exe`：内部验收目录包。

桌面验收的 Python 环境来自实际安装的 Windows CPU 哈希锁，通过临时环境目录关联供隔离应用调用；SF3 已按预期 SHA-256 校验。没有伪造模型文件、模型就绪标记、用户许可同意或 Hugging Face Token。验收数据库与日常使用数据库分离。
