# 固定桌面资源

`resources/bin` 由 `pnpm tools:fetch` 按当前平台与架构生成，并默认不进入 Git：

- Windows x64：uv 0.11.29，以及 FFmpeg n8.1.2 LGPL shared 构建。
- macOS x64 / arm64：各架构原生的 uv 0.11.29，以及 FFmpeg/FFprobe 静态构建。

下载资产和每个最终文件都由 `tool-manifest.json` 的 SHA-256 校验。清单中的下载入口即使由上游更新或替换，脚本也会安全失败；必须人工审核新构建并更新全部哈希，不能静默升级。

中国大陆构建可运行 `pnpm tools:fetch:cn`。脚本默认依次尝试 `ghfast.top`、`gh-proxy.com`、`ghproxy.net`，支持从 `.part` 文件续传，最后回退官方地址；也可用 `BANDBUDDY_GITHUB_PROXY` 指定自建前缀。镜像返回的文件仍必须通过同一组 SHA-256 校验。
