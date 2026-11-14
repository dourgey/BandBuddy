# 藏经阁（桌面版）

从主导航“曲库”之后进入“藏经阁”。可导入音频、从曲库选择原曲或指定分离轨，也可从歌曲菜单选择“转为 MIDI 谱”。导入仅保存音频副本，不触发分离。

首次打开“转谱组件”，阅读并接受模型许可与访问条件。在 Hugging Face 官方模型页获得访问权限后填写读取 Token，或导入含 `model.safetensors` 的官方模型目录。导入时严格校验所选模型的 SHA-256。CPU 默认 small；已检测到 CUDA / Apple MPS 时默认 medium；large 需主动选择。转谱环境、权重、播放音色与节拍模型准备完成后可离线使用。Token 通过 Electron safeStorage 保存，不写入任务载荷或日志。

## 使用与数据

- 工作台支持分轨选择、独奏、静音、音量、播放/暂停、点击定位、0.5–3 倍速、AB 循环与跟随。选择轨名可查看分谱；“全选”查看总谱。换页仍由同一个 AudioWorklet 播放，后台浮条可以暂停或返回。
- 钢琴卷帘按可视时间和轨道范围绘制。五线谱/TAB 每次读取 8 小节。记谱设置可修正 BPM、拍号、首拍、二分/三连量化及吉他/贝斯调弦；重新生成只处理缓存音符，不加载推理模型。
- 力度固定为 100，不是模型预测。整曲按乐器类别归轨，同类演奏可能合并；指定多个分离轨时以“来源轨 + 乐器”分别保存。TAB 是推荐指法，未分配的片段会给出时间位置提示，并保留完整原音高。
- 导出当前选中轨道的 Type 1 MIDI（默认量化，可切换原始时值）或 MusicXML。两个相同音色的乐器轨拥有独立通道；超过 15 条旋律轨使用独立 MIDI 端口，鼓轨保留通道 10。部分外部播放器不支持 MIDI 多端口，应在导入后检查路由。
- 首版支持最长 30 分钟、最多 32 条来源轨、128 条识别轨和每轨 200,000 音符。极端超出 MusicXML 可表示音域的音符会令记谱失败，但原始 MIDI 与卷帘保留。首版无逐音编辑/PDF 排版。

谱库存于独立的 SQLite `score_projects` / `score_config` 表，文件在曲库根目录 `_scores/<UUID>/`。其中 `source/` 是独立源快照；`runs/<UUID>/` 保存音符原始秒值、派生量化/指法、检测节拍、MIDI、MusicXML、模型版本和推理指标；`notation/` 为分段谱面缓存。删除原歌曲不删除谱库。新结果在作品所在磁盘的 `.tasks/` 内生成，校验后原子重命名并切换数据库指针；失败、取消或退出保留上一成功版本。

任务类型为 `transcribe`，与分离任务共用串行调度，录音或实时监听时暂缓启动。失败可在任务面板重试，也可明确选择 CPU 或较小模型重新转谱；不会静默切换模型。中断任务重新运行，不从模型内部 token 状态续跑。记谱失败不影响 MIDI 导出。

## 运行环境与资源

- 源码固定 Muscriptor 0.4.0 / `8a1ef88672cc23c26619adaff37ec48d82c0b906`。`python/worker/muscriptor/PROVENANCE.json` 校验 28 个原始文件；应用逻辑在独立的 `score_worker.py`。
- Python 环境位于运行环境根目录 `scores/env-<UUID>`，按哈希锁安装，与音频分离环境分开。Windows CPU/cu128/cu130、macOS ARM/Intel 各有依赖锁。环境损坏后重新“下载并准备”会验证并新建环境；切换目录后保留既有绝对路径环境。
- 权重在模型根目录 `muscriptor/<small|medium|large>`；完整 revision、配置、大小和 SHA-256 在 `resources/score-runtime/models.json`。节拍复用 `beat-this/final0.ckpt`，独立推理完整节拍/小节首拍序列。
- SpessaSynth 4.4.5 使用本地 `MuseScore_General.sf3`。多端口适配器 `scores/synth.ts` 修正此版本“新通道控制事件先于通道创建通知”的顺序；播放专用 MIDI 用显式 loopStart/loopEnd 保留片段前后静音。升级合成器时应复验并判断是否移除此适配器。
- 来源与许可见 [运行组件许可](../resources/score-runtime/LICENSES.md)。模型为 CC BY-NC 4.0，按需下载；安装包不包含模型、Token 或歌曲。

## 验证方法

```
pnpm typecheck
pnpm exec vitest run tests/scores.test.ts tests/scores-offline.test.tsx tests/job-state.test.ts tests/jobs-shutdown.test.ts tests/audio-session.test.ts
<转谱环境的 python> -m unittest discover -s python/worker/tests -p test_score_worker.py
pnpm build
```

AudioWorklet 的 20 轨、多端口、独奏/静音、长音定位、3 倍速、AB 前后静音与重叠加载可通过真实浏览器回归验证（需要 Python Playwright 和 Chromium）：

```
pnpm dev:renderer --host 127.0.0.1 --port 5178
python scripts/test-score-playback.py --soundfont /path/MuseScore_General.sf3 --output /path/playback-report.json
```

可设置 `MUSICXML_SCHEMA` 指向 [W3C MusicXML 4.0 官方 XSD](https://github.com/w3c/musicxml/tree/v4.0/schema)，启用额外的 MusicXML 模式校验（测试环境需 lxml）。其 xml.xsd / xlink.xsd 导入应解析到本地文件，方便离线验收。

浏览器 `?fixtures` 只提供标明“演示”的原创合成音符，不代表模型转谱精度。真实转谱需另行验证授权音频；不能用适配层模拟事件测试替代模型准确率测试。

真实基线可使用 `scripts/benchmark-scores.py`。准备钢琴、吉他/贝斯、鼓、人声、失真合奏和变速音频，建立 JSON 清单：

```json
[
  {
    "title": "原创钢琴片段",
    "file": "piano.wav",
    "license": "原创录制，允许本地转谱测试",
    "stemType": "piano",
    "reference": [{"instrument":"acoustic_piano","pitch":60,"start":0.5,"end":1.0}]
  }
]
```

```
<转谱环境的 python> scripts/benchmark-scores.py --cases cases.json --model small --weights /path/model.safetensors --beat-checkpoint /path/final0.ckpt --device cpu --ffmpeg /path/ffmpeg --output /path/report
```

每个模型/设备分别运行。报告记录总耗时、推理耗时、Windows 峰值驻留内存、CUDA 峰值分配显存和音符数；提供参考音符时，按起音 50 ms、结束 50 ms 或时长 20% 容差做一对一匹配，给出误音/漏音及 P/R/F1。没有参考标注时不报告准确率。非 Windows 的驻留内存目前为推理结束时采样，MPS 没有显存峰值指标。

当前实现的验收记录见 [SCORES_VERIFICATION.md](SCORES_VERIFICATION.md)。
