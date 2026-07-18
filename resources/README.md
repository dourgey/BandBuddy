# 固定桌面资源

`resources/bin` 由 `pnpm tools:fetch` 按当前平台与架构生成，并默认不进入 Git：

- Windows x64：uv 0.11.29，以及 FFmpeg n8.1.2 LGPL shared 构建。
- macOS x64 / arm64：各架构原生的 uv 0.11.29，以及 FFmpeg/FFprobe 静态构建。

下载资产和每个最终文件都由 `tool-manifest.json` 的 SHA-256 校验。清单中的下载入口即使由上游更新或替换，脚本也会安全失败；必须人工审核新构建并更新全部哈希，不能静默升级。
