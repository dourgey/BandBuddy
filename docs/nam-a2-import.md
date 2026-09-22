# NAM A2 导入回归

2026-09-22 从 [Tone3000 的 Fender Super Reverb 1965 - Edge of Breakup - A2](https://www.tone3000.com/tones/fender-super-reverb-1965-edge-of-breakup-a2-88775) 下载 `FNDR BFSR VB Edge WRM2 CAB FREE.nam` 复现。

- SHA-256：`68664c8a190254e4df4cc1838f773a7694a6f3a476f83d5e8044e41107d0d44a`
- NAM 文件版本 `0.7.0`，48 kHz，架构 `SlimmableContainer`。
- 顶层 `weights: []`；`config.submodels` 中有 Lite 和 Full 两个 WaveNet，分别包含 1,871 和 12,146 个权重，切换边界为 0.5 / 1。
- 模型文件仅留在本地 `.codex-tmp/arsenal/`，不作为测试夹具分发。默认回归使用自行构造的 Linear 容器。

## 根因与修复

1. 导入逻辑要求顶层权重非空，合法 A2 容器因而报“ NAM 模型结构无效”。现在为 `SlimmableContainer` 递归校验子模型、切换边界与子模型权重，普通 NAM 仍要求权重非空。文件选择器同时接受 `.nam` / `.nam2`；Tone3000 此次下载的 A2 文件扩展名实际为 `.nam`。
2. 绕过导入后，原生和 WASM 均报 `No config parser registered for architecture: SlimmableContainer`。NAM 解析器通过静态初始化注册，但静态库没有保留这些未被显式引用的对象。`bandbuddy_effects` 改为 CMake OBJECT 库，使消费者链接完整的注册代码。NAM Core 仍固定在原有的 `1f42f88535884450104b8711d7595019afa0495b`。

## 复验

```sh
pnpm native:audio
pnpm build:effects:wasm
pnpm exec vitest run tests/arsenal-import.test.ts
node scripts/test-nam.mjs

# 真实模型可从 Tone3000 下载后传入，不依赖开发者机器上的固定路径。
BB_NAM_TEST_MODEL='/path/to/capture.nam' pnpm exec vitest run tests/arsenal-import.test.ts
node scripts/test-nam.mjs '/path/to/capture.nam'
```

导入回归覆盖实际 `ArsenalService` 的校验、文件落盘、SQLite 记录、去重和 `prepare()`，只替换系统文件选择对话框。非法容器不得留下音色记录或资源文件。

DSP 回归分别执行 Full / Lite，比较容器输出与相应子模型单独加载的输出，检查非静音有限采样、128 / 257 帧分块一致性、原生/WASM 一致性、44.1 kHz 播放重采样和实际 audio-host WAV 导出。此次下载模型的原生/WASM 相对 RMS 误差：Lite `2.50e-7`，Full `2.03e-7`。两档均通过，且输出互不相同。
