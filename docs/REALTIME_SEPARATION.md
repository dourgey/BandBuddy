# 实时分轨

主导航的“实时分轨”复用现有六轨权重与分轨运行环境。一次推理产生鼓、贝斯、人声、吉他、钢琴、其他六轨；多选只改变输出混合。支持消除所选、只听所选，播放期间改变选择会淡化过渡。全部消除输出静音，全部独奏输出对应时间的原混音。

## 使用

1. 在设置中完成分轨运行环境准备。
2. Windows：安装虚拟播放设备，把外部播放器输出路由到该设备。页面选择它作为来源，另选物理耳机或扬声器作为输出。关闭虚拟设备的原声直通；不要把处理结果送回来源。
3. macOS 14.2 及以上：选择“电脑系统音频”，允许系统音频录制。处理进程创建私有 Core Audio Tap，排除 BandBuddy 当前进程及音频子进程，处理时抑制来源原声，关闭时销毁 Tap。旧系统可选已安装的双通道虚拟设备，将其与输出设备设为同一采样率。
4. 选择 44.1 / 48 kHz、计算后端、档位与声部。暂停来源播放器，再运行性能测试；测试会产生低音量确定性噪声。
5. 本次测试通过后才能开始。录音时可浏览此页，测试及开始操作不可用。离开页面会等待当前会话释放设备。

设备名称匹配仅用于提示可能的虚拟设备，不是驱动认证。缺少来源、输出或运行环境时需先完成配置。

## 准入条件

| 条件 | 流畅 | 低延迟 |
| --- | ---: | ---: |
| 历史音频 | 1200 ms | 420 ms |
| 每块输出 | 120 ms | 60 ms |
| 未来音频 | 100 ms | 20 ms |
| 单块处理 P99 上限 | 96 ms | 48 ms |
| 最长单块处理 | 120 ms | 60 ms |
| 设备链路延迟估计上限 | 1000 ms | 300 ms |

两档均使用 10 ms 交叉淡化与实际等待 40 ms 的输出预缓冲。模型加载后至少预热 5 秒，音频进入稳定播放后计时 60 秒。期间必须零输入丢包、零输出欠载、零缓冲溢出、零时间戳错误，并确认来源与生成的测试信号对应。延迟估计通过采集时间戳、重采样位置映射、播放设备时间戳和设备缓冲核算，覆盖块等待、未来音频、处理和排队；不代表扬声器至耳朵的声学测量。

主进程独立复核测试指标。通过状态仅保存在内存中，并绑定设备拓扑、设备选择、采样率、档位、实际后端、Python/模型/worker/原生库版本。切换声部或模式不失效；配置变化、设备变化、休眠或异常停止使其失效。配置与最近测试摘要写入数据库，重启后摘要仅供查看。

运行中持续监测。单次欠载短淡化，页面显示欠载计数；10 秒内累计三次、输入丢包、缓冲溢出、时间戳错误、延迟连续 2 秒超限、设备丢失或进程异常时停止并要求重测。通过测试不表示可以抵御之后的所有系统负载变化。

## 实现位置

- `packages/shared/src/realtime-separation.ts`：API、配置、状态、准入条件。
- `src/main/realtime-separation.ts`：会话状态、任务等待、配置持久化、通过记录、退出清理。
- `src/renderer/src/pages/RealtimeSeparation.tsx`：页面与设备路由指引。
- `python/worker/realtime_worker.py`：常驻模型、连续重采样、六轨混合、短淡化、漂移修正、测试与保护。
- `native/audio-host/src/realtime-audio.*`：Windows WASAPI 与有界 PCM 环形缓冲。音频线程只处理设备收发和计数，模型在 Python 工作线程运行。
- `native/audio-host/src/realtime-audio-mac.mm`：Core Audio Tap / 虚拟输入，私有聚合设备与 RAII 清理。

正常停止发出 worker 停止命令，等待设备关闭；无响应时终止进程树。实时会话活跃时暂停派发分轨/转谱等模型任务，开始前等待已有任务及 BPM 模型任务结束。

原生库跟随 `pnpm native:audio` 构建与安装，资源检查要求包含 DLL / dylib 和 Python worker。macOS 构建需要带有 14.2 Tap API 的 SDK；运行时通过版本检查保留旧系统的虚拟设备路径。[Apple Tap 接口说明](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)

## 开发验证

```powershell
pnpm exec vitest run tests/realtime-separation.test.ts tests/realtime-separation-ui.test.tsx
& "$env:LOCALAPPDATA/BandBuddy/envs/env/Scripts/python.exe" -m unittest discover -s python/worker/tests -p test_realtime_worker.py
pnpm build
```

原生缓冲与淡化测试纳入 `bandbuddy-audio-core-tests`。硬件脚本按设备名称匹配唯一端点，不修改系统默认设备：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
& "$env:LOCALAPPDATA/BandBuddy/envs/env/Scripts/python.exe" scripts/test-realtime-separation.py `
  --native resources/audio-host/win32-x64/bandbuddy-realtime-audio.dll `
  --model-root "$env:LOCALAPPDATA/BandBuddy/envs/models" `
  --source-name UU --output-name Realtek --profile smooth
```

`--profile lowLatency` 复测低延迟档。`--endurance-seconds 900` 是开发用持续播放压力检查，以独立进程持续生成测试音，经过实际采集、推理、重采样与输出；它直接调用 worker，不能给软件授予通过状态，也不能替代页面准入测试或音乐听感验收。使用不同设备名称时相应修改参数。

发布前仍须分别验证 Windows 实际播放器路由和至少 15 分钟播放，以及 macOS Tap 权限拒绝/恢复、正常停止后的原声恢复、虚拟设备、Apple Silicon / Intel 后端与安装包资源。Windows 上的源码和自动化结果不构成 macOS 实机验收。
