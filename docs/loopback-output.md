# Loopback 多路输出

BandBuddy 每次启动都会重新扫描当前电脑的播放及录音设备；每次打开设置也会重新读取设备列表。列表不预设声卡名称或通道数。上次选择的设备仍可用时保留选择，已经断开时回退到系统默认；不会因为发现 Loopback 就自动选中它。每条分轨的 OUT 选项根据当前输出设备实际可用的通道数生成。下文的 8 路配置只是本机验证示例，硬件测试中的设备名称和通道数不作为 APP 的默认配置。

在 Loopback 中创建启用的 Pass-Thru 设备，添加 4 组 Output Channels，并保持输入 1→输出 1、输入 2→输出 2，依此类推到 8。在 BandBuddy「设置 → 性能与播放 → 音频输出」选择该设备，然后在每条分轨的 OUT 中选择 1–2、3–4、5–6 或 7–8。

例如：人声 → 1–2、鼓 → 3–4、贝斯 → 5–6、吉他 → 7–8。同一通道对中的多条分轨会混音；单声道素材会复制到所选通道对的左右两路。节拍器和录音回放仍使用 1–2。系统扬声器不必设为 Loopback。

在 DAW 中以同一 Loopback 设备为输入，分别选择对应的输入通道。Loopback 没有 Monitor 时，系统扬声器听不到这些通道是正常的；需要监听时，可在 Loopback 单独添加 Monitor。

## 8 路被识别为 2 路的原因

Loopback 新建的设备可能有 8 个 CoreAudio 声道，但每个声道标签都是 `kAudioChannelLabel_Unknown`。Chromium 会忽略这些标签并回退到立体声。BandBuddy 在打开所选输出前，检查该设备的 CoreAudio UID，只有 Loopback 的多声道布局全部为 Unknown 时，才将标签设为 Discrete 0…N−1，并读回验证。已有的自定义/环绕声布局和物理设备不会被改写。相同名称的多个设备不会被猜测匹配。

若设置发生变化，先切到无声输出，再重新打开所选设备，避免 Chromium 沿用旧的 2 路信息，也不会把音频临时送到系统扬声器。

参考：[Loopback Pass-Thru](https://www.rogueamoeba.com/support/manuals/loopback/?page=passthru)、[Chromium 的 macOS 声道布局解析](https://chromium.googlesource.com/chromium/src/+/main/media/audio/mac/audio_manager_mac.cc)。

## 实际声卡回归测试

需要 macOS、Xcode 命令行工具，以及名称为 `Loopback Audio`、至少 8 输入/输出通道、1:1 Pass-Thru 映射的设备。测试期间不要让其他应用向该设备播放音频。测试会选择该虚拟设备、修复上述未知标签，并短暂采集它的 8 路输入；不会采集物理麦克风。

```sh
pnpm native:audio
pnpm test:loopback
# 如设备已改名：
LOOPBACK_DEVICE_NAME='BandBuddy Bus' pnpm test:loopback
```

测试使用真实 Electron 音频引擎生成不同频率的素材，经 Loopback 输出后用 CoreAudio 同时回录 8 路。验证立体声、单声道、升/降八度（鼓不变调）、播放中换路由、Mute/Solo、设备来回切换、节拍器。未变调时要求目标频率存在、其他通道测试频率至少低 40 dB；变调时保留原有共振峰处理，以带泛音的信号检查目标频段，并通过独奏要求其余 6 路静音，避免将算法产生的边带误认为串音。所有回录均要求无 xrun。设备切换测试在暂停状态切至内建扬声器再返回，避免播放测试音到扬声器。

测试数据、辅助程序及独立 Electron 配置均写入临时目录，结束后清理。此测试不替代实体多输出声卡或 Windows 的硬件验证。
