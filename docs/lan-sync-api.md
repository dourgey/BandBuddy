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

## 网页 PCM 连续播放

发现能力新增 `pcm-stream-v1`。网页选择歌曲时请求 `GET <basePath>api/v2/songs/<songId>/playback`，返回与 manifest 相同的歌曲结构，但省略 peaks，资源 `sha256` 为空字符串。该接口只读取文件元数据，不扫描整首音频计算校验和。正式下载校验仍必须使用原有 `/manifest`。

网页使用 `new URL('api/v1/pcm', baseUrl)` 构造连接地址，再将 `http:` 替换为 `ws:`（`https:` 对应 `wss:`）。稳定根地址也支持 `/api/v1/pcm`，使用访问首页时签发的 HttpOnly 会话 Cookie。升级连接沿用局域网地址、Host、同源 Origin 和会话验证；最多四个独立连接，关闭 LAN 会立即关闭所有连接及其处理进程。

电脑使用一个 FFmpeg 解码进程按需读取已有分轨，原生 `bandbuddy-audio-host --lan-pcm` 使用持续的 Signalsmith 处理器变速、变调和混音。输出为 **48 kHz、双声道、交错 little-endian Float32 PCM**，无 WAV 文件头，无 MP3/AAC 编码。音频负载固定约 384000 字节/秒（3.072 Mbps），与歌曲包含多少分轨无关。原速原调绕过伸缩算法；鼓轨参与变速但不升降调。整个乐器混音总线不使用仅适合人声的共振峰锁定。

客户端控制为 JSON 文本帧，单条最多 16 KiB：

```json
{
  "type":"configure", "generation":1,
  "songId":"11111111-1111-4111-8111-111111111111",
  "position":0, "rate":1, "pitch":0, "playing":true,
  "mix":[{"gain":1,"muted":false,"solo":false,"visible":true}],
  "loop":null
}
```

`mix` 顺序必须与 playback 元数据的全部 stems 一致。`generation` 是递增的正 uint32；`position` 和循环起止以**原歌曲秒数**表示；`rate` 范围 0.5–2，`pitch` 为 -12 至 +12 的整数。`loop` 可设为 `{"start":10,"end":20}`。完整轨与细分替代轨不能同时可见；手动导入的已有分轨按独立轨道处理。会话不改变电脑的播放位置、混音或音频设备。

电脑返回 `{"type":"ready","generation":1}` 后，客户端以 `{"type":"pull","generation":1,"count":20}` 申请音频。每次 count 范围 1–24，电脑待发送额度最多 24；没有额度便停止推进解码/处理，管道和 WebSocket 队列均有上限。每包最多 960 帧，即 20 ms。普通网页以约 400 ms 为目标预读窗口，先收到约 160 ms 再安排播放；不足时冻结歌曲时钟并缓冲，避免静默走进度。

PCM 使用二进制帧，40 字节头之后紧跟 `frames * 2` 个 Float32 样本。头字段均为 little-endian：

| 偏移 | 类型 | 内容 |
| --- | --- | --- |
| 0 | uint32 | `0x314d4350`，即 PCM1 |
| 4 | uint32 | generation |
| 8 | uint32 | 本 generation 从 0 递增的包序号 |
| 12 | uint32 | frames，最大 960 |
| 16 | float64 | 本包第一帧对应的原歌曲秒数 |
| 24 | float64 | 本包播放倍速 |
| 32 | uint32 | sampleRate，固定 48000 |
| 36 | uint32 | flags，bit 0 表示歌曲最后一包 |

循环时原歌曲时间回到 A，输出音频时钟连续；播放器使用包内时间同步歌词和视频。结束时还会返回 `{"type":"ended","generation":1}`。出错返回 `{"type":"error","generation":1,"message":"…"}`，随后客户端停止旧音频并显示重试入口。

分轨音量、静音、Solo、完整轨/细分轨切换使用 `{"type":"mix","generation":1,"mix":[...]}`，更新同一连续处理器的增益，不重新加载歌曲。调节倍速、调性或跳转时发送新 generation；旧 generation 音频不再接收。倍速/调性切换保留已缓冲音频，并在相同歌曲位置以短交叉淡化切换；跳转立即清理旧队列。循环边界也有短淡化。普通 HTTP 页面直接安排短 AudioBuffer 播放，不依赖 AudioWorklet 或浏览器端音频算法。

## 兼容资源

旧版音轨 URL 的 `?web=1&pitch=0` 仍返回 44.1 kHz 双声道 192 kbps MP3，`pitch` 支持 -12 至 +12。当前网页音频不再使用这个整轨转换接口。

视频 URL 的 `?web=1` 仍返回无声 H.264 MP4；首次视频转换可能等待，独立于 PCM 音频。旧版兼容资源转换串行执行，相同资源/调性请求去重，最多缓存 128 个资源，缓存只在当前 LAN 会话内有效。原始 manifest 的长度、类型、校验和不适用于动态转换资源或 PCM 音频。

## 错误与生命周期

JSON 错误形如 `{"error":"NOT_FOUND"}`。主要状态：400 请求/协议版本不合法，403 非局域网/来源不合法，404 会话失效或歌曲资源不存在，405 不支持方法，413 握手正文过大，415 非 JSON，416 Range 无效，500 文件读取或媒体准备失败。关闭 LAN 后连接直接关闭，客户端应显示桌面端离线并保留下载进度。

## 开发与验证

`pnpm native:audio` 构建原生 PCM 接口；`pnpm build` 生成 `out/renderer/lan.html` 与其资源。桌面服务从构建后的 renderer 目录提供页面；开发模式开启 LAN 前也需要构建一次页面。针对性测试：`pnpm exec vitest run tests/lan.test.ts tests/lan-pitch.test.ts tests/lan-pcm.test.ts tests/lan-player.test.ts`。PCM 集成测试使用真实 FFmpeg、原生处理器和 WebSocket，覆盖立体声逐采样混音、变速/变调频谱、起点/末帧、额度、快速切换、独立会话、实时混音、循环与关闭。

已有分轨导入沿用 App 的九个轨道槽位，一次支持 2–9 条音轨；每条可以选择预设名称或输入自定义名称。文件标准化到统一时长但不移动起点，时长差超过 500 ms 时显示补静音确认。曲库迁移新增可空的轨道名称字段，旧曲目继续显示原预设名称。
