# 军火库经典设备：研究、实现与覆盖边界

更新：2026-09-22。本文区分可运行的电路研究模型、结构近似和未实现设备；不能将目录解释为“所有主流设备均已完整复刻”。当前没有任何型号经过实机重放校准。

## 可用入口

军火库中点击箱头图片或 AMP + CAB：箱头引擎选择“白盒 · 前级电路”，箱体引擎选择“物理模型 · C12N”。也可自由搭配 NAM + 物理箱体、白盒前级 + IR。开启模块、调整参数并保存预设。导入 NAM/IR 后会选中刚导入资源，已有资源可在下拉框选择。

“白盒设备”提供 TS808、SD-1、RAT、Micro Amp、Distortion+、Fuzz Face。信号链新增“调制 / 动态”槽，提供六种不同结构，支持前后移动。每条链现有一个驱动槽、一个调制/动态槽，不能同时堆叠此槽里的多个型号。模块控制使用原生可访问表单；室内场景和器材仍使用已有图片。

## 本次实际实现

| 类别 / 设备 | 模型内容 | 保留的限制 |
| --- | --- | --- |
| AB763 美式清音前级 | 两级 12AX7 共阴极放大；第一级之后的 FMV 音调网络；级间电容；可变音量 | AB763 电路家族的降阶前级，不是某一序列号的 Deluxe/Twin；未含混响通道、相位反相器和功放 |
| 2203 英式过载前级 | 2.7kΩ/0.68µF 首级、10kΩ 不旁路冷削波级、820Ω 第三级、后置 FMV | 阴极跟随器为理想缓冲；忽略格栅导通、栅阻/级间负载耦合、真实 Miller 电容和亮度旁路支路；不是完整 JCM800 |
| C12N 1×12 开背 | 厂商 8Ω T/S 参数、线圈电阻/电感、反电动势、振动质量、顺性、机械损耗 | 开背辐射为固定偶极高通近似 |
| C12N 2×12 开背 | 两只同相驱动、辐射求和 | 忽略单元位置导致的离轴干涉；不等于 Twin Reverb 箱体实测响应 |
| C12N 4×12 密闭 | 四只扬声器共享空气弹簧，10–300 L 容积可调 | C12N 不是 V30/Greenback；不是 Marshall 1960 或 Mesa Rectifier 箱体复刻 |
| Micro Amp 提升 | 56kΩ/47pF 反馈、2.7kΩ+500kΩ 与4.7µF增益支路、10MΩ/0.1µF输入、15µF输出耦合 | 理想偏置、有限带宽/转换速率运放近似；原硬件仅一个增益旋钮，额外输出电平明确标为软件控制 |
| Distortion+ 锗失真 | 1MΩ反馈、4.7kΩ+1MΩ/47nF支路；1µF耦合、10kΩ限流、锗二极管、1nF旁路电容共同求解 | 名义锗器件参数非某只1N270实测，741为降阶模型；无虚构Tone旋钮 |
| Fuzz Face 硅管 | 两只名义Ebers–Moll晶体管、100kΩ全局反馈、发射极分段旁路、五节点MNA、输出470Ω/8.2kΩ分压 | 固定10kΩ源阻抗；名义硅管β120/180、Is10fA；不包含锗管漏电、击穿、电池内阻或真实拾音器负载 |
| Phase 90 移相 | 四级47nF理想有源全通、输入输出耦合、三角LFO、干湿求和 | JFET简化为正值可变电导，非拟合Vgs模型；不含Block版本R28反馈 |
| 光耦颤音 | 光敏电阻分压、8ms点亮/80ms恢复状态、正弦光驱动 | 类别级研究电路，不冒用Fender光耦实测型号 |
| BBD Chorus / Flanger | 三角LFO、分数延迟、输入输出滤波；Flanger有再生反馈 | **结构近似**，不是逐桶电荷转移或MN3007/MN3207器件模型；没有CE-2/BF-2完整复刻声明 |
| RLC Wah | 串联RLC等效带通的TPT状态空间、350–2100Hz扫频与阻尼 | 类别级谐振器，未包含Cry Baby/Vox晶体管有源反馈和拾音器负载 |
| OTA压缩 | 整流RC包络、差分对电流规律、可变偏置与恢复时间 | **结构近似**；不是Dyna Comp完整反馈/预加重电路，也不是1176/LA-2A |

原有 TS808、SD-1、RAT 的电路与限制见 [r1 文档](arsenal-whitebox.md)。原有七段 EQ、数字 Delay、算法 Reverb 仍可串接，不把通用算法改名为某块 BOSS 单块。

## 主流设备族调研清单

“主流”没有封闭且公认的型号全集。以下是按不同电路结构建立的后续覆盖清单，不是销量排名。未完成项不出现在可用型号下拉框中。

| 设备族及代表 | 需要独立实现的结构 | 当前状态 |
| --- | --- | --- |
| Fender AB763 / 5F6-A / 5E3 | 早期音调与晚期音调、共阴极/阴极跟随器、LTP/阴极分相器、不同整流及反馈 | 仅AB763降阶前级可用，其余待实现 |
| Marshall Plexi 1959 / 2203 / JCM900 | 并联通道混合与亮度旁路、冷削波级、某些型号的固态削波及运放 | 仅2203降阶前级可用；场景JCM900外观不代表其算法 |
| Vox AC30 Top Boost / AC15 EF86 | Top Boost独立交互音调；EF86五极管；功放后级Cut | 未实现，不能替换FMV参数冒充Top Boost |
| Hiwatt DR103 / Orange OR120 | 多级干净余量、独立音调；FAC耦合电容选择、不同反馈及功放 | 未实现 |
| Mesa Mark / Dual Rectifier | 失真前TMB与失真后五段GEQ；Rectifier模式/整流/反馈切换 | 未实现；不是通用“美式高增益”改名 |
| Soldano SLO / Peavey 5150 / ENGL / Friedman | 多级耦合、冷偏置、栅极导通与阻塞失真、Depth/Presence所在反馈位置 | 未实现，须先锁定电路修订；部分公开资料不足 |
| Celestion Greenback / V30 / G12T-75 / Blue，Jensen C12N/P12N，EV EVM12L | 分别核验T/S、复阻抗和声学模态；开背、密闭、倒相、不同单元阵列 | 当前仅C12N 8Ω与三种理想布局；其他单元未伪造参数 |
| TS808 / SD-1 / RAT / Distortion+ / Micro Amp | 反馈削波、非对称、对地削波、提升 | 上述五种原型可运行 |
| Klon / Bluesbreaker / Timmy / OCD | 多支路混合、联动电位器、不同音调位置与削波拓扑 | 未实现；Klon尤其不能以“干湿混合TS”代替 |
| BOSS DS-1 / BD-2 / Metal Zone | 晶体管预增益、分立运放级联、有源均衡和多级削波 | 未实现 |
| Fuzz Face / Tone Bender / Big Muff | 耦合BJT、源阻抗敏感输入、两级反馈二极管削波与被动中频凹陷 | 仅Fuzz Face名义硅管电路已实现；Tone Bender/Big Muff待实现 |
| Cry Baby / Vox Wah / envelope filter | 电感与有源晶体管反馈、包络扫描 | 当前仅通用RLC Wah；实机有源网络未完成 |
| Dyna Comp / Ross / 1176 / LA-2A / noise gate | OTA/FET/光耦/门限结构及独立检波回路 | 当前仅通用OTA近似；其他待实现 |
| Phase 90 / Small Stone / Uni-Vibe | JFET全通、OTA全通、四组不等参数光控级 | 当前仅Phase 90降阶电路 |
| CE-1/CE-2 / Electric Mistress / BF-2 / vibrato | BBD采样时钟、抗混叠及重建、偏置、反馈和干湿符号 | 当前两种类别结构近似，非量产设备白盒复刻 |
| DM-2 / Memory Man / RE-201 / Echoplex | BBD/磁带模型、压扩器、饱和、抖晃、多磁头 | 未实现；现有Delay为数字延迟 |
| Fender弹簧 / plate / hall / shimmer / octave / pitch | 色散波导与模态、FDN、粒子/相位声码器等不同算法 | 现有通用算法混响可用；弹簧/移调等未实现。数字效果应依据原始算法建模，不能一律称“电路白盒” |

## 数学实现与单位

### 前级

`triodeCurrent()` 独立实现 Koren 的名义12AX7模型（MU100、EX1.4、KG11060、KP600、KVB300），保留原公式正支路的因子2。直流工作点在准备阶段求解，电容初值设为静态电压。每采样联合解阳极负载和阴极RC，保留阴极电容历史；有界牛顿迭代加二分回退。正栅压时没有真实栅流，故不能用来声称精确阻塞失真。

FMV使用五节点导纳矩阵和三只电容的梯形伴随模型，Bass/Middle/Treble互相加载；不是三只独立EQ。源端简化为理想电压源，AB763源阻抗以及2203阴极跟随器的真实加载仍待耦合。Miller效应使用固定名义RC近似。前级全部4×过采样、两侧FIR，总延迟32个基准采样；Gain/TMB/Master/输入标定10ms平滑。矩阵为固定数组，不在回调分配堆内存。

### Fuzz Face 非线性网络

两只晶体管用Ebers–Moll双结模型，五节点（Q1基极、Q1集电极/Q2基极、Q2发射极、Q2集电极、输出分压点）联合求解。输入、发射极和输出电容保留梯形伴随状态，电位器实际改变发射极旁路比例。直流初始化排除上电瞬态；动态牛顿最多40次，对正向PN结电压增量做限制，避免一步跨越过多热电压。矩阵、雅可比与历史均为固定数组。测试包含极端输入下的KCL残差与零失败步数。未收敛时保留上一有效输出和状态，不把无效节点写回。

### 箱体

连续状态 `x=[i, v, displacement]`：

```
Le * di/dt = Vin - Re*i - Bl*v
Mms * dv/dt = Bl*i - Rms*v - K*displacement
d(displacement)/dt = v
Ksealed = 1/Cms + rho*c²*Sd²*N/Vbox
```

使用梯形积分。C12N 8Ω数据：Re6.05Ω、Le0.9mH、Bl10.46、Mms29.9g、Cms66µm/N、Qms7.52、Sd490.9cm²。由质量/顺性导出共振，由Qms导出损耗，未混用其他阻抗版本。一个归一化输入采样等于每个单元1V。压力按活塞加速度、单元数量和远场距离计算，软件映射固定为2个数字单位/Pa；多单元会更响，独立箱体增益可补偿。

开背的180Hz偶极高通、离轴角度控制的双极低通是显式声学近似，**不包含纸盆分割振动、箱壁模态、反射或麦克风响应**。距离0.25–3m不等于近距离拾音模型。没有把此阻抗反馈到NAM或前级；功放与扬声器电气负载闭环仍未实现。IR依旧是获取具体实机箱体录音响应的可用选择。

### 调制与动态

各设备保存独立状态，参数10ms平滑。Phase90固定47nF、24kΩ最大移相电阻；LFO控制正值等效JFET电导，不是器件参数拟合。静态四级网络在干湿1:1时的两个陷波点由 `tan(pi/8)/(2*pi*R*C)` 与 `tan(3*pi/8)/(2*pi*R*C)` 得到。其余设备见上表的近似范围。OTA非线性目前没有独立过采样，不能声称混叠已经达到实机对照验收标准。

## 存储、运行与兼容

- 旧四/五模块顺序保留，相应补入默认旁通的drive与mod；旧AMP/CAB默认继续走NAM/IR，旧预设声音处理算法不变。
- 所有新参数写入公共预设和独立轨道快照；不依赖第三方音色文件。切回NAM/IR保留此前资源选择。
- 设备/引擎/顺序切换走效果链准备；普通参数走现有SPSC控制队列。资源或加载失败保留上一实例。
- 原生监听、原生离线湿声及导出使用同一个`Effects`实现。原始录音仍是干声；处理器不会修改传入的PCM。
- 缓存版本为`bb-dsp-3-classic-1-nam-0.5.4`。算法延迟：NAM路径无重采样160帧；白盒前级路径192帧（48kHz为4ms）；均不包含声卡驱动延迟。
- WASM构建和数值测试包含所有新模型。**仓库的Web Audio录音轨回放尚未接入WASM效果节点，不能据此宣称已实现录后播放中调音。**
- 沿用原先实例替换淡入，尚非旧新实例完整交叉淡化。没有声卡30分钟验收、Windows本机运行、实机频响/谐波/动态校准报告。

## 验证

```
cmake --build native/audio-host/build/darwin-arm64 --parallel 4
native/audio-host/build/darwin-arm64/effects/bandbuddy-classic-test
# 先加载本机 Emscripten 环境
pnpm build:effects:wasm
pnpm test:whitebox
pnpm typecheck
pnpm test
pnpm build
```

`classic_test.cpp`：三极管直流与KCL残差；C12N三布局、50/113/440/2000Hz与独立连续时间机电传递函数对照；Phase90静态陷波；8/44.1/48/96/192kHz、旁通、快速调参和实例隔离。解析对照仅验证声明的模型，不验证与实机相同。

`test-whitebox.mjs`：六种驱动×两种过采样，加两种前级/三种箱体/六种调制的组合；原生127/257帧输出逐样本一致；WASM113帧相对RMS阈值1e-4；干声哈希不变；实际WAV湿声导出的160/192帧补偿和100ms尾音。`arsenal-classic.test.ts`检查迁移、参数边界和快照；UI测试检查选择、保存、重排和监听更新。

本次实跑结果：隔离副本类型检查、生产构建与50个Vitest文件/284个测试通过；原生两个DSP测试程序、音频宿主自测通过。18组原生/WASM相对RMS最大约1.08e-7；不同回调分块逐样本一致。Fuzz极端输入测试通过正向PN结步长限制后，在16/48/192/768kHz内部采样率、±20V输入下零失败步数。该离线测试不能替代声卡实时验收。

主工作区同时有其他页面的未提交开发，首次构建被缺失的woodshed.css中断，因此另建仅含本次改动的隔离副本完成构建和回归；没有覆盖或提交其他页面的工作。该样式文件随后由其开发流程补齐，主工作区生产构建复跑也已通过。

前端验证采用Playwright，原因：Browser plugin not available。检查军火库 → 白盒前级/物理箱体 → 参数修改保存 → 调制重排监听 → 小窗口控制，记录页面错误和截图。

## 资料与授权

以下为器件模型作者、原始电路分析者、图纸整理者及厂商资料。实现代码为本仓库自行编写；没有复制GPL效果器代码，也没有将禁止转载的图纸打包进应用。品牌名称只标明电路研究对象。

- [Koren：电子管SPICE模型与名义参数](https://www.normankoren.com/Audio/Tubemodspice_article.html)
- [AB763电路与信号路径分析](https://robrobinette.com/How_The_AB763_Deluxe_Reverb_Works.htm)
- [Marshall 2203/2204电路分析](https://robrobinette.com/How_the_Marshall_JCM800_Works.htm)
- [VOX原始AC30图纸索引](https://www.voxac30.org.uk/vox_ac30_circuit_diagrams.html)
- [Jensen C12N厂商规格](https://www.jensentone.com/specification-sheet/16)
- [Celestion Vintage 30厂商页面](https://celestion.com/product/vintage-30/)（未提供足以完成本模型的全部参数，不据此伪造）
- [DAFx 2008：吉他箱体的非线性建模](https://www.dafx.de/paper-archive/2008/papers/dafx08_17.pdf)
- [Micro Amp参考图纸，JD Sleep，2012修订](https://generalguitargadgets.com/pdf/ggg_mamp_sc.pdf)
- [Distortion+原创电路分析存档](https://electrosmash.mas-effects.com/mxr-distortion-plus-analysis.html)
- [Fuzz Face原创电路分析存档](https://electrosmash.mas-effects.com/fuzz-face.html)
- [Phase90原创电路分析存档](https://electrosmash.mas-effects.com/mxr-phase90.html)
- [CE-2原创电路分析存档](https://electrosmash.mas-effects.com/boss-ce-2-analysis.html)
- [Dyna Comp原创电路分析存档](https://electrosmash.mas-effects.com/mxr-dyna-comp-analysis.html)
- [Klon虚拟模拟建模比较论文](https://arxiv.org/abs/2009.02833)
- 用户提供的《吉他软件效果器白盒算法与典型设备建模调研》。
