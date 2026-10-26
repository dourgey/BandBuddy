/** English model aliases; stable DSP ids and imported asset names stay intact. */
export interface EffectIdentity { name: string; prototype: string; basis: string }
const identity = (name: string, prototype: string, basis = '电路降阶模型'): EffectIdentity => ({ name, prototype, basis })
const identities: Record<string, Record<string, EffectIdentity>> = {
  drive: {
    ts808: identity('Green OD 808', 'Ibanez Tube Screamer TS808'),
    sd1: identity('Super OD 01', 'BOSS SD-1 Super OverDrive'),
    rat: identity('Rodent Dist 308', 'Pro Co RAT'),
    microamp: identity('Micro Boost 133', 'MXR Micro Amp M133'),
    'distortion-plus': identity('Plus Dist 104', 'MXR Distortion+ M104'),
    fuzzface: identity('Round Fuzz 66', 'Dallas-Arbiter Fuzz Face（硅管配置）'),
    ds1: identity('Hard Dist 01', 'BOSS DS-1', '结构近似'),
    bd2: identity('Blue Drive 02', 'BOSS BD-2 Blues Driver', '结构近似'),
    centaur: identity('Gold Drive 94', 'Klon Centaur'),
  },
  amp: {
    'fender-twin': identity('US Double 763', 'Fender Twin Reverb AB763 · Normal'),
    'marshall-jtm45': identity('Brit 45', 'Marshall JTM45 · Bright'),
    'marshall-jcm800': identity('Brit 800', 'Marshall JCM800 2203'),
    'vox-ac30': identity('Brit Chime 30', 'VOX AC30 · Top Boost'),
    'mesa-rectifier': identity('Cali Dual 100', 'MESA Dual Rectifier Rev F · Red Modern'),
    orange: identity('Citrus 120', 'Orange 高增益箱头家族', '旧版结构近似'),
    mesa: identity('Cali Lead 90', 'MESA 高增益箱头家族', '旧版结构近似'),
    vox: identity('Brit Chime 15', 'VOX 清亮箱头家族', '旧版结构近似'),
    'ab763-pre': identity('US Pre 763', 'Fender AB763 前级家族', '旧版电路降阶模型'),
    '2203-pre': identity('Brit Pre 2203', 'Marshall 2203 前级', '旧版电路降阶模型'),
  },
  cab: {
    'fender-deluxe': identity('1x12 US C12N', 'Fender Deluxe · 1×12 Jensen C12N', '机电与声学近似'),
    'fender-twin': identity('2x12 US C12N', 'Fender Twin · 2×12 Jensen C12N', '机电与声学近似'),
    'marshall-1960ax': identity('4x12 Brit G25', 'Marshall 1960AX · 4×12 Greenback', '机电与声学近似'),
    'marshall-1960b': identity('4x12 Brit T75', 'Marshall 1960B · 4×12 G12T-75', '机电与声学近似'),
    'vox-ac30c2': identity('2x12 Chime G25', 'VOX AC30C2 · 2×12 Greenback', '机电与声学近似'),
    'mesa-rectifier': identity('4x12 Cali V30', 'MESA Rectifier · 4×12 V30 参考配置', '机电与声学近似'),
    'orange-ppc412': identity('4x12 Citrus V30', 'Orange PPC412 · 4×12 V30', '机电与声学近似'),
    open112: identity('1x12 Open C12N', 'Jensen C12N · 开背单单元参考配置', '旧版机电近似'),
    open212: identity('2x12 Open C12N', 'Jensen C12N · 开背双单元参考配置', '旧版机电近似'),
    sealed412: identity('4x12 Closed C12N', 'Jensen C12N · 密闭四单元参考配置', '旧版机电近似'),
  },
  mod: {
    phase90: identity('Classic Phaser 90', 'MXR Phase 90'),
    'optical-tremolo': identity('Opto Trem 60', '经典光耦 Tremolo 电路家族', '类别电路近似'),
    chorus: identity('Analog Chorus 1024', '经典 BBD Chorus 家族', '类别结构近似'),
    flanger: identity('Analog Flange 512', '经典 BBD Flanger 家族', '类别结构近似'),
    vibrato: identity('Pitch Vibrato 07', '经典延迟调制 Vibrato 家族', '解析数字算法'),
    wah: identity('Classic Wah 500', '经典电感谐振 Wah 家族', 'RLC 等效模型'),
    'ota-compressor': identity('Squeeze Comp 136', 'MXR Dyna Comp / OTA 压缩家族', 'OTA 结构近似'),
    'stereo-chorus': identity('Dual Chorus 134', 'MXR M134 Stereo Chorus', '功能参考 · 数字合唱'),
    'step-flanger': identity('Step Flange 13', 'Alexander F.13 原版', '功能参考 · 数字镶边'),
    'aqueduct-vibrato': identity('Multi Vibrato 08', 'EarthQuaker Devices Aqueduct', '功能参考 · 数字颤音'),
    'fixed-wah': identity('Fixed Wah 01', 'Dunlop QZ1 Q Zone Fixed Wah', '功能参考 · RLC 等效'),
  },
  dynamic: {
    compressor: identity('Studio Comp 04', '经典包络检波压缩算法', '通用数字算法'),
    boost: identity('Clean Boost 24', '经典线性电平提升', '通用数字算法'),
    gate: identity('Noise Gate 06', '经典滞回噪声门', '通用数字算法'),
  },
  eq: { graphic: identity('Graphic EQ 07', '经典图示均衡器', '通用数字算法'), parametric: identity('Parametric EQ 04', '经典参数均衡器', '通用数字算法') },
  delay: {
    digital: identity('Digital Delay 229', '经典数字反馈 Delay', '通用数字算法'),
    analog: identity('Analog Delay 02', '经典暗色模拟 Delay 的频谱特征', '数字结构近似'),
    tape: identity('Tape Echo 201', '经典磁带 Delay 的回声特征', '数字结构近似'),
    reverse: identity('Reverse Delay 08', '经典反向 Delay', '通用数字算法'),
    pingpong: identity('Stereo Echo 20', '经典立体声 Ping-pong Delay', '通用数字算法'),
  },
  reverb: {
    room: identity('Studio Room 08', '经典 FDN 房间混响', '通用数字算法'),
    hall: identity('Concert Hall 16', '经典 FDN 大厅混响', '通用数字算法'),
    plate: identity('Studio Plate 140', '经典扩散网络 Plate 混响', '算法近似 · 非钢板物理仿真'),
    spring: identity('Vintage Spring 63', '经典色散 Spring 混响', '算法近似 · 非实物弹簧标定'),
  },
}
export function effectIdentity(category: string, id: string): EffectIdentity | undefined { return identities[category]?.[id] }
export function nameModels<T extends { id: string; name: string }>(category: string, models: readonly T[]): Array<Omit<T, 'name'> & { name: string }> {
  return models.map(model => ({ ...model, name: effectIdentity(category, model.id)?.name ?? model.name }))
}
