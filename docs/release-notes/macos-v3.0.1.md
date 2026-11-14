# BandBuddy 3.0.1 · macOS Apple Silicon（Apple 公证）

本次发布 macOS Apple Silicon（M 系列芯片）安装包。应用与 DMG 均已使用 Developer ID 签名、通过 Apple 公证，并附加公证票据；ZIP 包含同一已附加票据的应用。Gatekeeper 验证为 `accepted / Notarized Developer ID`。

## 下载与安装

- `BandBuddy-3.0.1-macos-arm64.dmg`：推荐安装包，打开后将 BandBuddy 拖入 Applications。
- `BandBuddy-3.0.1-macos-arm64.zip`：解压后将 BandBuddy.app 移入 Applications。
- `SHA256SUMS-macos-arm64.txt`：两个安装文件的 SHA-256 校验值。
- `NOTARIZATION-REPORT.json`、`SIGNATURE-REPORT-macos-arm64.json`：公证、签名和启动验证记录。

完整本地分轨要求 **macOS 13.4 或更新版本**。应用基础功能保留 macOS 13.0 最低声明；不包含 Intel Mac 安装包。首次分轨仍需联网下载私有 Python 环境和模型。无需关闭 Gatekeeper 或手动删除隔离属性；macOS 可能显示正常的首次下载来源确认。

Windows 用户请使用 [3.0.0 Windows 版本](https://github.com/dourgey/BandBuddy/releases/tag/v3.0.0)。

## 本次修复

- 将 Apple Silicon 的 ONNX Runtime 固定为 1.23.2，并刷新全部 59 项带 SHA-256 的依赖，修复 macOS 13 用户无法安装 macOS 14 专用依赖的问题。
- 按原生库的真实部署版本将完整分轨门槛设为 macOS 13.4，系统检查保留小版本。
- 优先选择 ARM64 专用 wheel，修复误选仅包含 Intel 原生库的 lameenc universal2 包。
- 禁止 Python 在签名应用内生成字节码缓存，修复运行后应用签名失效的问题。
- 加速推理失败时保留相同模型和质量参数回退 CPU，并限制默认 MPS 内存占用。
- 修复 macOS 原生宿主构建、人声配置文件字节校验和签名部署版本解析，重新构建原生音频／插件宿主及效果器 WASM。

## 验证范围

- 应用测试：1,041 项通过、29 项跳过；Python 测试：47 项通过。
- 类型检查、生产构建、原生自检及 native/WASM 效果器对比通过。
- 干净环境的 260 个原生二进制均包含 ARM64，最低部署版本不高于 macOS 13.4。
- 六轨 CPU 分离、两个 MDX ONNX 模型及 fast / balanced / high 三档吉他完整链路的真实短音频推理通过。
- 导入、播放／暂停、循环／变速保存、FLAC 导出、局域网响应、排练与桌面歌词检查通过。
- 最终 DMG 挂载、ZIP 解压、票据验证、Gatekeeper 检查通过。模拟浏览器下载隔离标记后，系统分发检查与隔离启动通过，启动后签名仍有效。

测试主机为 macOS 26.6.2 ARM64；未完成 macOS 13.4 真机、完整人声细分模型推理、所有外部声卡／第三方插件及重型 MPS 模型流程的全面验收。
