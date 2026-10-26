# 军火库箱头、箱体与 IR（2026-10-26）

本次依据用户提供的《电吉他箱头箱体建模与 IR 资源调研》实现。**具名型号是电路与箱体配置的研究对象；当前是可运行的降阶模型，没有完成实机重放、盲听或逐台标定。** 稳定性、数值误差与 CPU 测试不等于实机音色一致性。

## 产品入口与兼容

- 新建 AMP 默认 US Double 763；可选 Brit 45、Brit 800、Brit Chime 30、Cali Dual 100，或用户导入的 NAM。面板说明各自以 Twin AB763、JTM45 Bright、JCM800 2203、AC30 Top Boost、Dual Rectifier Rev F Red Modern 为原型。全部原生型号的产品名称与原型说明集中在 `effect-identities.ts`，详见 [单块模型与命名](pedal-models.md)。
- CAB 只有一个型号选择。物理箱体与“IR · 箱体响应”在同一列表。选择 IR 后直接显示 IR 列表、搜索、批量导入与当前选中状态；导入成功自动选中首个资源。取消不改变选择；部分导入失败会刷新成功项并显示具体错误。
- IR 与物理箱体切换保留各自设置。第二条 IR、混合、声像、极性、延时继续可用；第二条 IR 在高级参数中选择。
- 新型号使用新 ID。`ab763-pre / 2203-pre / orange / mesa / vox` 和 `open112 / open212 / sealed412` 仍由原处理器加载；加载旧预设时显示其旧版选项，新建模块选择新模型。
- 随软件提供 72 条来源和许可明确的箱体 IR（62 条实体箱体、10 条 Korg 数字模拟器响应），详见 [内置资源与逐文件署名](../resources/cabinet-irs/README.md)。NAM 仍由用户导入。导入文件按原始 SHA-256 去重，原字节保存；元数据记录原文件名、采样率、声道、位深、编码与前导静音。WAV 的正负极性、相对电平和前导延迟不会被峰值归一化或自动对齐。
- 原生监听、离线湿声导出共用 `Effects`。原生宿主与 WASM 均重新构建，随踏板扩展缓存版本更新为 `bb-dsp-8-pedals`。这是开发工作区交付，未生成新的安装包。

## 箱头结构

| 型号 | 电压放大与音调结构 | 功放等效 |
| --- | --- | --- |
| Fender Twin AB763 Normal | 两级 12AX7；第一级后 FMV，250 pF / 100 nF / 47 nF，100 kΩ slope | 较强负反馈、6L6 类推挽 |
| Marshall JTM45 Bright | 两级 12AX7；820 Ω 阴极、Bright 支路、后置 FMV，56 kΩ slope | KT66 类偏置、负反馈和供电压降 |
| Marshall JCM800 2203 | 三级 12AX7；2.7 kΩ / 0.68 µF 首级、10 kΩ 无旁路冷削波级、后置 FMV | EL34 类推挽、环内 Presence |
| VOX AC30 Top Boost | 220 kΩ 首级阳极、2.5 µF 阴极旁路；第二级无旁路；50 pF / 22 nF / 22 nF，1 MΩ Bass/Treble 与固定 10 kΩ 支路的独立 Top Boost 连接 | 无负反馈、EL84 类推挽、输出 Cut；没有虚构 Middle/Presence 控件 |
| MESA Dual Rectifier Rev F Red Modern | 四级 12AX7；220 kΩ 首末级阳极、第三极 39 kΩ 冷偏置；680 pF / 22 nF / 22 nF、47 kΩ slope；前级 Presence | 无负反馈的 6L6 类推挽；不把 Red Modern Presence 当作功放负反馈 |

三极管电流来自本仓库既有 Koren 名义 12AX7 方程；用两张紧凑的标量函数表替代逐样本 exp/log/pow，阳极及栅压关系仍按公式计算。每级联合求解阳极负载与阴极 RC，最多 10 次括区间 Newton，必要时最多 24 次二分回退。准备时求直流工作点，避免启动充电声。测试覆盖电流函数近似误差及负载方程残差。

音调网络使用固定大小节点导纳矩阵、梯形电容历史；参数每 32 个设备采样更新一次系数，控制值以 10 ms 平滑。不是三只互不加载的 EQ。2×/4× 过采样均采用窗化 sinc 输入/输出滤波，固定算法延迟 32 帧。低负载档仍有抗混叠滤波，但不声称任何档位都消除了可闻混叠。

功放是**结构约束的灰盒**：相反方向的 3/2 次方导通支路、有限源电压摆幅、输出电阻、RC 电源压降、低频输出变压器等效；有反馈型号将频率相关反馈和扬声器电流放在同一标量隐式方程内求解，最多 8 次 Newton + 32 次二分。求根边界包含负载反电动势，不把负载端电压错误地钳在源电压范围内。不是 EL34/6L6/KT66/EL84 全器件电路仿真。偏置、输出电阻、摆幅、时间常数属于名义工程估计，未由实机辨识。

Twin、JTM45 和 AC30 原型没有此处所选电路版本的 Master 控件，其 `LEVEL` 是功放后的线性软件电平，不改变失真和负载求解；JCM800、Rectifier 的 `MASTER` 在功放之前。数字增益分配采用名义相位反转器/功放驱动比例；测试检查默认匹配链路可用电平，以及非 Master 型号的输出比例不改变波形。

其余明确简化：阴极跟随器为理想缓冲；前级分块使用固定源/负载近似；Miller 为固定名义极点；没有真实栅流及 blocking distortion、完整相位反转器、屏栅/整流电路、磁滞或电源各支路的统一求解。输入在明确数值工作区间限幅。`inputVolts` 是输入标定，输出按固定软件比例映射到数字电平。

## 扬声器负载与物理箱体

`SpeakerPort` 的状态为线圈电流、锥盆速度、位移，采用梯形积分：

```
Le di/dt = Vin - Re i - Bl v
M dv/dt = Bl i - Rms v - K x
dx/dt = v
K = 1/Cms + rho c² Sd² N / Vbox   （密闭箱）
```

串并联数量同时影响扬声器端电压、总电流与阻抗。所有物理参数以 SI 单位存储；单元与密闭空气弹簧构成被动负载。测试将实时复导纳与独立连续时间解析阻抗对照，计入双线性频率扭曲。

自动负载只匹配**紧邻、开启的物理 CAB**。有其他模块或 VST 插在中间、CAB 旁通、IR、无 CAB 时，使用箱头的默认参考负载（Twin→C12N 双单元；JTM45/JCM800→Greenback 4×12；AC30→Greenback 2×12；Rectifier→V30 4×12）。高级设置可改成 8 Ω 电阻。IR 不能恢复功放看到的电负载，因此不会从 IR 猜测阻抗。

箱头内部负载在过采样率工作，输出箱体在设备采样率独立运行同一线性机电模型；这是分区近似，并非跨任意效果链共享全部物理状态。箱头负载在自己的电压标度运行，输出有固定数字缩放。不同档位仍需听测校准。

| 箱体配置 | 单元与接线 | 净容积参考 |
| --- | --- | --- |
| Fender Deluxe | 1× C12N，开背 | 40 L（开背不增加密闭空气弹簧） |
| Fender Twin | 2× C12N，并联，开背 | 70 L |
| Marshall 1960AX | 4× G12M-25，2 串 2 并，密闭 | 170 L |
| Marshall 1960B | 4× G12T-75，2 串 2 并，密闭 | 180 L |
| VOX AC30C2 | 2× G12M-25，串联，开背 | 65 L |
| MESA Rectifier | 4× V30 参考单元，2 串 2 并，密闭 | 200 L |
| Orange PPC412 | 4× V30，2 串 2 并，密闭 | 150 L |

这些净容积为可调整的工程估计，不是精确内部尺寸测量。C12N 使用既有 Jensen 8 Ω T/S 数据；Celestion 的质量、力因数、Qms、线圈电感等包含估计值。V30 为通用参考，不冒充 MESA 定制单元；AC30C2 是 Greenback 配置，不冒充 Alnico Blue。

输出由活塞加速度辐射、开背偶极高通、三段分割振动滤波、高频衰减和离轴低通组成。分割振动滤波参数来自下述开放项目的拟合值，但在本实现的简化电机模型上使用，不能沿用原项目的拟合误差或实机结论。距离范围 0.25–3 m 是远场近似，不提供虚假的近场连续摆麦。多单元按同相共享运动、每单元平均声压作固定软件电平映射（箱体输入 1 FS 对应 1 V、输出 1 Pa 对应 1 FS）；没有独立单元互辐射、箱板、热压缩或位移非线性。这是数字音色电平约定，不是麦克风/声压级标定。

## IR 卷积、导入与实时成本

- 接受单/立体声 PCM16/24/32 与 Float32 WAV，8–192 kHz，0–2 秒（不含零长度）。校验 RIFF 长度、帧对齐、扩展格式 GUID、采样有限性；拒绝静音、损坏或不支持格式。原始文件不改写。
- 同采样率直接使用原 taps。异采样率离线执行窗化 sinc FIR 重采样，保持持续时间和 tap 的有符号和（DC 传递增益），包含边界权重修正；不做峰值归一化、最小相位变换或峰值对齐。带宽受目标 Nyquist 限制，重采样不是逐字节或全频带等同原文件。
- 前 1024 taps 用 128 帧分区；其余用 1024 帧分区，尾部缓冲延迟与 1024-tap 偏移抵消。只存半谱，FFT 旋转因子预计算。保留全部尾音，不以缩短 IR 换性能。
- 回调不读盘、不解析 JSON、不分配堆内存；卷积、模型准备在控制线程完成，继续使用宿主已有的旧/新处理器交叉淡化。参数使用控制队列和平滑；新型号净容积、质量与负载变化计入结构键。
- 纯原生模块链中，单 AMP + CAB 的 DSP 延迟为 160 帧（48 kHz 下 3.33 ms）；单 CAB 为 128 帧。此数值不包含 VST 插件图、设备驱动、接口和输入/输出缓冲的往返延迟。

## 可复现检查

```
pnpm native:audio
# 配置过本机 Emscripten 后：
pnpm build:effects:wasm
pnpm test:amp-cab
pnpm test:whitebox
pnpm typecheck
pnpm build
pnpm test:arsenal-output
```

`amp-cab-test.cpp` 检查直接 FIR 对照（含分区边界及 384000 taps 完整尾音）、重采样电平/极性/延迟、复阻抗、电子管函数误差、极端控制、静音恢复、非有限输入、旁通延迟、实例区别、反应性负载和回调分配。`test-whitebox.mjs` 同时覆盖新增 17 组原生/WASM对照、127/257/113 帧分块、干声不变、实际 WAV 湿声导出和延迟补偿。Vitest 覆盖真实临时 WAV 导入与持久化、类型切换、异步导入、保存、参数/结构更新分流。

本机参考：Windows、Ryzen 7 5800H、Release、48 kHz 双声道，单箱头 2× 约 9–13% 单核，4× 约 18–25% 单核；两秒双声道 IR 约 1.6% 单核。这里是离线实时等效 CPU 比例，不能当作声卡零掉音保证。不同并发负载、调度和机器需重新测量。

未完成的外部验收：实物声卡长时监听、硬件 AB/盲听、真实设备频响/失真/动态对照、安装包与干净机器验收。

## 参数与许可来源

- 用户提供的本次调研文档；历史模型基础见 [arsenal-classic-models.md](arsenal-classic-models.md)。
- [Koren 电子管模型](https://normankoren.com/Audio/Tubemodspice_article.html)。
- [GainStageFx 0.49.0，固定提交 436f041](https://github.com/BurningTreeC/gainstagefx/tree/436f04141eb343ac757ef255b165f58f60858022)，仅适配扬声器参数表；没有集成其 Rust/MNA 引擎。MIT 版权与许可完整保存在 `native/effects/AmpCab-NOTICES.txt`，由 CMake 安装到运行时 licenses。
- 该提交的 [扬声器参数与拟合标记](https://github.com/BurningTreeC/gainstagefx/blob/436f04141eb343ac757ef255b165f58f60858022/src/acoustics/speaker.rs)、[AC30 结构与原始图纸出处](https://github.com/BurningTreeC/gainstagefx/blob/436f04141eb343ac757ef255b165f58f60858022/docs/models/brit_ac30.md)、[Rectifier Rev F 模式/Presence/反馈核对](https://github.com/BurningTreeC/gainstagefx/blob/436f04141eb343ac757ef255b165f58f60858022/docs/models/cali_rectifier.md)。

品牌名称用于描述研究参考，不表示厂商授权或声学一致性认证。
