# 固定桌面资源

`resources/bin` 由 `pnpm tools:fetch` 生成并默认不进入 Git：

- uv 0.11.29，用来安装 BandBuddy 私有 CPython 3.12。
- FFmpeg n8.1.2 LGPL shared Windows x64，包含 FFmpeg、FFprobe 及其动态库。

下载包和每个最终文件都由 `tool-manifest.json` 的 SHA-256 校验。FFmpeg 的 `latest` 下载入口是上游发布方式；一旦上游替换资产，脚本会安全失败，必须人工审核新构建并更新全部哈希，不能静默升级。
