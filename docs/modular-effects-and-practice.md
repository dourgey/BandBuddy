# 模块化军火库与练习体验（2026-09-23）

## 使用与数据

- 军火库在 INPUT → OUTPUT 之间自由添加、删除、重复、移动或更换模块，最多 24 个。AMP 与 CAB 独立。预设名可直接修改；旧固定链预设按原先顺序迁移。
- 金色旋钮支持拖动、滚轮和方向键，Shift + 滚轮加速。输入标定、过采样使用模型默认值，不再展示。
- 离开军火库会关闭其输入监听并释放原生测试流，包含“启动尚未完成便切页”的情况。
- 录音轨可选军火库预设、实时监听效果声、删除整轨。磁盘录音始终是干声；效果快照独立保存。回放和导出根据当前轨效果处理，修改预设不会覆盖干声。回放首次生成效果缓存可能需要等待。
- 录音的实时效果监听仍要求同一原生双工音频设备。选该声卡的输入、输出及正确通道，并将耳机接入该声卡；分离的设备可录音，但不能使用这条实时监听通路。
- 设置修改自动排队保存，无单独保存按钮；设置每次打开从分类首页进入。
- 系统学习／专项练习按乐器卡片 → 目标列表 → 正文进入；浏览记录持久化；内容收藏与练习收藏独立筛选。
- 鼓机常用节奏预设、吉他和鼓示范使用本地 Ogg Vorbis 采样。108 个 WAV 压缩前 31,108,752 字节，压缩后 1,779,164 字节。来源与转换参数见 `sample-assets.json`，可运行 `node scripts/prepare-practice-samples.mjs` 重建。

## 算法与研究依据

这里的品牌名表示所参考的声音／电路家族，不表示厂商授权或经过实机校准的完整复制。NAM 和 IR 仍可用于特定设备的捕获与测量响应。

| 模块 | 实现 | 依据与边界 |
|---|---|---|
| Dynamic | RC 包络、阈值／比例压缩、Attack／Release、噪声门、线性 Boost | 通用动态处理，不声称特定 1176、LA-2A 或 Dyna Comp |
| TS808、SD-1、RAT、MXR、Fuzz | 延续二极管／晶体管网络模型，默认 4 倍过采样 | 原有方程和验证见 `arsenal-whitebox.md`、`arsenal-classic-models.md` |
| DS-1 | 输入高通、前增益与带宽、对地二极管削波、双支路音调 | 降阶结构近似；器件负载与实际运放未逐件拟合 |
| BD-2 | 两级非对称饱和、级间滤波、音调和输出电平 | 行为／结构模型；不是完整分立运放电路求解 |
| JCM800 2203、AB763 | Koren 三极管、耦合高通、FMV 音调网络 | 前级降阶模型，不含完整功放与变压器 |
| Orange、MESA 风格 | 四级三极管、不同增益分配、级间耦合和偏置、后置音调 | 类别近似；Orange 非 OR120 的 FAC；MESA 非完整 Mark／Rectifier 切换电路 |
| VOX 风格 | 两级三极管、阴极旁路和明亮音调 | 使用降阶音调网络，未完整复刻 Top Boost 交互或功放 Cut |
| CAB | C12N 机电系统的开背／密闭布局，或导入 IR | C12N 不等同于 V30／Greenback；IR 可替换为实际箱体 |
| EQ | 五段 80/240/750/2200/6600 Hz；七段 100/200/400/800/1600/3200/6400 Hz 双二阶滤波 | 五段频点不代表整台 MESA Mark 电路 |
| Chorus／Flanger／Vibrato／Phaser | LFO 分数延迟、反馈、全湿振音、四级全通移相 | BBD 为结构近似，不含逐桶电荷转移 |
| Digital／Analog／Tape／Reverse Delay | 环形延迟、反馈滤波／饱和、磁带抖晃、两窗反向读取交叉淡化 | 反向延迟反转时间片段，非延迟一个固定采样；非 DM-2／RE-201 完整复刻 |
| Room／Hall／Plate／Spring Reverb | 八路反馈梳状网络、四级 Schroeder 扩散；Spring 额外全通色散链 | 算法空间与色散近似，未求解真实弹簧完整物理系统 |

参考资料：

- [BOSS 官方 DS-1／SD-1／BD-2 对比](https://articles.boss.info/whats-the-difference-between-a-ds-1-sd-1-and-bd-2/)：削波和频谱特征；不能据此推断未公开元件值。
- [DAFx 2010：Macak、Schimmel，电子管放大器实时仿真](https://www.dafx.de/paper-archive/2010/DAFx10/MacakSchimmel_DAFx10_P12.pdf)：级联非线性与动态偏置的分块方法。
- [Orange Rockerverb MKIII 官方手册](https://orangeamps.com/wp-content/uploads/2017/05/Rockerverb-MKIII-Series-Manual-%E2%80%93-Orange-Amps.pdf)：四级 Dirty 增益与音调控制。
- [VOX AC30/AC15 官方手册](https://voxamps.com/wp-content/uploads/support/AC30C2_X_AC15C2_OM_EFGS2.pdf)：Top Boost 音调交互及 Tone Cut；当前近似的限制据此明确。
- [DAFx 1999 调制效果](https://dafx.de/paper-archive/1999/disch.pdf)：Chorus、Flanger 与时变延迟。
- [DAFx 2013 弹簧混响建模](https://dafx.de/paper-archive/details/omUNRAXkKDeEOxMkIyPwQg)：延迟与色散全通方法。

## 验证

`tests/arsenal-modular-native.test.ts` 实际运行编译后的原生 DSP：检查全链分块一致性、原始输入字节不变、重复模块、顺序影响及新增型号输出有界且互不相同。`arsenal-monitor-lifecycle.test.ts` 验证启动／停止竞态。`practice-samples.test.ts` 验证解码复用、采样音高、包络与释放。浏览器验证覆盖目录、正文切换、收藏跳转、旋钮滚轮、鼓机采样加载和播放完成。

这些检查不等同于实物声卡监听、长时间录音或与真实硬件的盲听校准。浏览器 fixture 不能证明原生设备可用；新效果由原生引擎承担，旧的实验性 WASM 工件不用于当前播放链。
