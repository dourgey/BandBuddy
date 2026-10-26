# 军火库单块模型与命名

产品名称、经典原型与建模层级集中维护在 `packages/shared/src/effect-identities.ts`。选型菜单、效果链卡片和编辑面板共用名称；稳定 DSP ID 不变，因此旧预设继续解析。编辑面板在旋钮下方显示原型与实现层级。用户导入的 NAM、IR 和第三方 VST 保留资源原名。

名称统一使用英文＋数字型号。参考 [Line 6 官方型号表](https://line6.com/helix-models/?locale=en_US) 的 `Brit J45`、`US Double`、`Scream 808`，[HeadRush 官方型号表](https://www.headrushfx.com/prime) 的 `Green JRC-OD`、`K Drive`，以及 [Fractal 官方手册](https://www.fractalaudio.com/downloads/manuals/fas-guides/Fractal-Audio-Blocks-Guide.pdf) 的 `Super OD`：箱头使用地域/音色＋型号，踏板使用颜色/音色/电路功能＋型号；箱体采用 `4x12 Brit G25` 这样的单元数量、尺寸与扬声器线索。原型品牌保留在说明中，通用数字算法按实际功能命名。

## 新增模型

| 产品名 / DSP ID | 参考原型 | 实现范围 |
| --- | --- | --- |
| Gold Drive 94 / `centaur` | Klon Centaur | 分块电路降阶：输入耦合、联动增益、两条前馈、对地二极管削波、求和、主动 Treble、输出耦合 |
| Dual Chorus 134 / `stereo-chorus` | MXR M134 Stereo Chorus | 数字合唱，独立立体声相位、Width/Intensity/Rate、Bass/Treble、低频保留 |
| Step Flange 13 / `step-flanger` | Alexander F.13 原版 | 数字镶边，Sweep/八步/包络三种控制、正负反馈；Rate=0 时 Sweep 的 Depth 固定延迟位置 |
| Multi Vibrato 08 / `aqueduct-vibrato` | EarthQuaker Devices Aqueduct | 正弦、三角、斜坡、方波、随机、包络深度、包络速度、包络音高；Env P 的 Depth 改为干湿 Mix |
| Fixed Wah 01 / `fixed-wah` | Dunlop QZ1 Q Zone | 固定谐振带通，Peak 380–2000 Hz、Q、Level；没有自动 LFO |

后四款是依据公开控制行为独立构建的数字算法，不包含原厂固件；合唱没有模拟逐级 BBD 电荷转移，固定哇音没有完整复制 QZ1 电路。Gold Drive 94 使用名义元件、理想运放与电源轨限制，没有把制造偏差、温度或真实拾音器负载当作已知。这里的命名不表示原厂授权；所有算法均未完成对应实机的重放、盲听和逐台标定。

## 数值和实时约束

- Gold Drive 94 的线性前馈使用固定 3 节点和 5 节点导纳矩阵、梯形电容伴随模型。非线性支路联合求解耦合电容与 Shockley 二极管端口，使用有界 Newton 与二分回退。所有分支一起以 2×/4× 采样率运行，避免并联支路的过采样延迟错位；沿用 32 帧抗混叠 FIR 延迟。
- Gold Drive 94 的 Treble 沿用参考实现的稳定极点映射；放大级采用标准双线性变换，不宣称与参考框架的频率预扭曲和过采样滤波器逐样本一致。元件依据和 BSD 署名见 `native/effects/Pedal-NOTICES.txt`，安装资源带上同一文件。
- 调制延迟线在创建时一次分配。合唱采用分数延迟；镶边反馈限于 ±0.85，使用凸插值和被动低通保持环路有界。步进目标平滑为 1.5 ms，数字颤音使用互补窗的双读头音高移动，避免持续包络下延迟无限增长。
- 旋钮、开关旁通、合唱低频保留均平滑变化。振荡器与包络跨处理块连续；波形/模式切换通过已有异步准备与宿主淡变机制替换处理器，普通旋钮保持原实例。
- `Knob` 统一支持悬停滚轮：每格 5 个最小步长，Shift 为 1 步；标签、旋钮、数值框共用该行为。限制在合法范围，忽略缩放手势、纯水平滚动及禁用控件；数值量化相对于最小值。
- 湿声缓存标识更新为 `bb-dsp-8-pedals`，避免旧处理器输出被复用。

## 可重复验证

`pnpm test:pedals` 运行原生电路/算法测试与 19 组原生–WASM 对照。独立复阻抗计算校验三条前馈/前放响应；另检查二极管残差、8–192 kHz、增益极限、尾音衰减、32 帧旁通、声道差异、反馈极性、固定哇音频响、包络音高和回调分配。脚本还经过真实 WAV 导出与插件宿主处理，并校验采样一致性、分块不变性与控制热更新。`pnpm test:whitebox` 扩展覆盖既有处理器，需先构建原生宿主和 WASM。

`tests/arsenal-knob.test.tsx` 与 `tests/pedal-library.test.tsx` 校验悬停、连续滚动、精调、边界、禁用、命名、模式参数和预设兼容。CPU 输出是本机双声道 48 kHz 处理一秒音频的墙钟占比，不是完整应用负载，也不等于物理声卡往返延迟。

## 依据与许可

- 用户提供《主流电吉他效果器白盒建模算法与开放实现调研》。其中对未公开型号和版本差异的讨论作为范围依据，不作为已经复现的证据。
- [Chowdhury, KlonCentaur](https://github.com/jatinchowdhury18/KlonCentaur/tree/f3bb633a593b6fbb22a44c1ef9d1dbedbfe92d5b)，固定提交 `f3bb633a593b6fbb22a44c1ef9d1dbedbfe92d5b`，Traditional 分支的元件、网络和传递函数，BSD-3-Clause。未引入 JUCE、RNN 权重或其界面资源。
- [MXR Stereo Chorus 官方说明](https://www.jimdunlop.com/mxr-stereo-chorus/)。
- [EarthQuaker Devices Aqueduct 官方模式说明](https://www.earthquakerdevices.com/aqueduct)。
- [Dunlop QZ1 官方手册](https://www.jimdunlop.com/content/manuals/QZ1.pdf)。
- F.13 的控制行为依据用户调研中的原版手册摘录；该原版手册链接本轮未能直接打开，不把 F.13 Neo 的控制和功能混入实现。
