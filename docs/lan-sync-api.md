# BandBuddy 局域网练琴与移动端同步协议 v1

在桌面 App「设置 → 局域网模式」开启。开关立即生效，默认关闭，不跨进程重启保持开启。退出 App 或关闭开关后，服务、下载和媒体转换停止，缓存删除，旧访问地址失效。浏览器与移动端各自播放，不控制桌面端播放器。

## 发现桌面端

HTTP 优先监听 `0.0.0.0:60232`。端口占用时依次尝试 60233–60332，仍然占用则让系统分配空闲端口。设置页显示实际地址，可复制到手机浏览器。电脑和访问设备需在同一局域网，系统防火墙需放行。服务仅接受私有 IPv4 / 回环 / 链路本地地址；暂不支持 IPv6-only 网络。

移动端推荐先 UDP 发现，再扫描端口：

1. 向当前网卡的子网广播地址 UDP **60232** 发送 UTF-8 JSON：
   ```json
   {"service":"bandbuddy-lan","type":"discover","version":1}
   ```
2. 桌面端以单播回复发送方的源端口，回复形如：
   ```json
   {
     "service":"bandbuddy-lan",
     "version":1,
     "name":"BandBuddy",
     "port":60233,
     "handshake":"/api/v1/handshake",
     "capabilities":["stems","lyrics","video","range","sha256"]
   }
   ```
3. 使用数据报的源 IP 加回复中的 TCP 端口进行握手。建议等候 1–2 秒、去重桌面端地址，最多重试两次；不要持续广播。
4. UDP 被网络隔离或 60232/UDP 被其他程序占用时，可低并发扫描本机当前子网的 60232–60332/TCP，对候选端点请求 `GET /api/v1/discovery`。成功响应与 UDP 内容相同。系统分配的其他端口需通过 UDP 或手动输入设置页地址发现。

iOS / Android 客户端需自行申请系统规定的局域网 / 网络发现权限。此仓库仅实现桌面服务，不包含移动客户端。

## 握手

```http
POST /api/v1/handshake
Content-Type: application/json

{"service":"bandbuddy-lan","version":1,"platform":"ios"}
```

`platform` 为 `ios`、`android` 或 `desktop`。成功响应：

```json
{
  "service":"bandbuddy-lan",
  "version":1,
  "name":"BandBuddy",
  "port":60232,
  "handshake":"/api/v1/handshake",
  "capabilities":["stems","lyrics","video","range","sha256"],
  "basePath":"/s/<48位随机十六进制会话标识>/",
  "expires":"when LAN mode stops",
  "songs":"api/v1/songs"
}
```

将 `basePath` 与当前桌面端 origin 拼成会话根地址。之后所有响应中的相对 URL 都相对于这个**会话根地址**解析，不能相对于 manifest 路径解析。会话标识相当于访问凭证，移动端不要写入日志。桌面用户开启模式即允许同局域网原生客户端握手、读取完整已完成曲库；目前没有逐客户端审批或写入接口。

原生客户端不发送 `Origin`。网页端只允许同源请求，不开放跨域 CORS。服务校验 Host，拒绝外部网站域名。握手只接受 JSON，最大 4 KiB。传输使用局域网 HTTP，不是互联网服务。

## 歌曲列表

`GET <basePath>api/v1/songs`

```json
{
  "version":1,
  "songs":[{
    "id":"11111111-1111-4111-8111-111111111111",
    "title":"排练歌曲",
    "artist":"乐队",
    "durationMs":180000,
    "updatedAt":"2026-09-22T00:00:00.000Z",
    "stemCount":6,
    "manifest":"api/v1/songs/11111111-1111-4111-8111-111111111111/manifest"
  }]
}
```

只返回状态为 ready 的歌曲。列表无本地文件路径。客户端可用 `id` 去重，`updatedAt` 作刷新提示；下载版本以 manifest 中的资源 SHA-256 为准。歌曲可能在下载过程中被删除或重新分轨，此时刷新清单重试。

## 歌曲 manifest

`GET <basePath>api/v1/songs/<songId>/manifest`

类型定义在 `packages/shared/src/lan.ts`。字段：

| 字段 | 内容 |
| --- | --- |
| version / id / title / artist / durationMs / updatedAt | 协议版本与歌曲元数据 |
| bpm / musicalKey | 可空的速度与调性 |
| lyrics | 可空歌词文档，包含 `fileName`, `title`, `artist`, `album`, `cues: [{timeMs, lines: string[]}]` |
| stems | 所有现有分轨，含隐藏的吉他备选轨；每项有 `id`, `type`, `name`, `durationMs`, `sampleRate`, `channels`, `defaultVisible`, `audio`, `peaks` |
| artwork / video | 可空资源描述 |

每个非空资源描述包含：

```json
{
  "url":"media/<songId>/stem/<stemId>",
  "bytes":12345678,
  "sha256":"<64位十六进制文件校验和>",
  "mimeType":"audio/flac"
}
```

`type` 是桌面轨道类别标识，**展示名称必须使用 `name`**，以支持自定义命名。`defaultVisible` 用于默认混音选择，防止同时播放完整吉他和它的细分替代轨。手动导入的已有分轨均为独立轨道，默认全选。移动端应保存全部音轨，以便切换练习方式。

## 资源下载与断点续传

- `GET`：完整下载；`HEAD`：获取长度与类型，无响应正文。
- 单范围 `Range: bytes=1048576-`、`bytes=0-1023` 或 `bytes=-1024` 返回 **206**，包含 `Content-Range`。
- 完整响应 **200**；越界/无效/多范围请求 **416**，包含 `Content-Range: bytes */<总字节数>`。
- 客户端续传前重新获取 manifest。如果 SHA-256 或字节数变化，丢弃旧临时文件并重新下载。
- 下载到临时文件，完成后校验总长度和 SHA-256，再原子移入移动端曲库。视频、封面和 peaks 可以按需下载。
- 原始下载保留桌面端的 FLAC / MP3 等编码，不应用升降调或混音。移动端需支持对应格式，或使用下述网页兼容资源。
- 建议同时下载不超过 2–3 条资源；网络中断时指数退避重试，桌面端关闭后重新发现并握手。

只提供 ID 对应的受管资源，不接受任意磁盘路径，不提供上传、修改曲库、删除歌曲或远程控制桌面的接口。

## 网页兼容播放资源

对音轨资源 URL 加 `?web=1&pitch=0`，获得 44.1 kHz 双声道 192 kbps MP3。`pitch` 支持 -12 至 +12 的整数半音，使用桌面原生 Signalsmith 保持时长进行处理。网页的每轨音量与 M/S 在浏览器本地处理；改变升降调时暂停并重新加载音轨，加载后用户点击继续播放。

对视频资源 URL 加 `?web=1`，获得无声 H.264 MP4，音频始终来自分轨。首次转换可能较慢，网页显示加载状态。转换串行执行、相同资源/调性请求去重，在当前 LAN 会话内缓存。缓存最多 128 个转换资源，超过后重新开关 LAN 模式清理；缓存不包括用户曲库文件。网页使用流式播放，避免将长歌曲的所有解码音轨同时放入移动设备内存。

原始 manifest 的长度、类型、校验和**不适用于**这些动态转换资源。移动端正式同步优先使用原始下载。

## 错误与生命周期

JSON 错误形如 `{"error":"NOT_FOUND"}`。主要状态：400 请求/协议版本不合法，403 非局域网/来源不合法，404 会话失效或歌曲资源不存在，405 不支持方法，413 握手正文过大，415 非 JSON，416 Range 无效，500 文件读取或媒体准备失败。关闭 LAN 后连接直接关闭，客户端应显示桌面端离线并保留下载进度。

## 开发与验证

`pnpm build` 生成 `out/renderer/lan.html` 与其资源；桌面服务从构建后的 renderer 目录提供页面。开发模式开启 LAN 前也需要构建一次页面。接口测试：`pnpm exec vitest run tests/lan.test.ts tests/stem-import.test.ts`。

已有分轨导入沿用 App 的九个轨道槽位，一次支持 2–9 条音轨；每条可以选择预设名称或输入自定义名称。文件标准化到统一时长但不移动起点，时长差超过 500 ms 时显示补静音确认。曲库迁移新增可空的轨道名称字段，旧曲目继续显示原预设名称。
