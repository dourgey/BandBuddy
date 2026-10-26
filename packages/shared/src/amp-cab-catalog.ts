import { nameModels } from './effect-identities.js'
/** Stable ids: new circuit families do not reinterpret saved legacy models. */
export const MODELED_AMPS = nameModels('amp', [
  { id: 'fender-twin', name: 'Fender Twin Reverb · AB763', description: 'Normal 通道两级 12AX7、前置交互音调；6L6 推挽、供电压降和反应性负载的降阶模型。' },
  { id: 'marshall-jtm45', name: 'Marshall JTM45 · Bright', description: 'Bright 通道、两级 12AX7、后置音调；KT66 推挽与整流供电的降阶模型。' },
  { id: 'marshall-jcm800', name: 'Marshall JCM800 · 2203', description: '三级 12AX7、10kΩ 冷削波级、后置交互音调；EL34 推挽与负反馈的降阶模型。' },
  { id: 'vox-ac30', name: 'VOX AC30 · Top Boost', description: '两级 ECC83、独立 Top Boost 音调拓扑、功放 Cut；无负反馈 EL84 推挽的降阶模型。' },
  { id: 'mesa-rectifier', name: 'MESA Dual Rectifier · Red Modern', description: 'Rev F 四级 12AX7、39kΩ 冷削波级、后置音调与前级 Presence；无负反馈 6L6 推挽的降阶模型。' }
] as const)
export const MODELED_CABS = nameModels('cab', [
  { id: 'fender-deluxe', name: 'Fender Deluxe · 1×12 C12N', volumeLitres: 40, sealed: false, description: 'C12N 配置的开放背板参考箱体；厂商 T/S 数据、分割振动滤波与开背辐射近似。' },
  { id: 'fender-twin', name: 'Fender Twin · 2×12 C12N', volumeLitres: 70, sealed: false, description: '两只 C12N 并联、开放背板；厂商 T/S 数据及辐射近似。' },
  { id: 'marshall-1960ax', name: 'Marshall 1960AX · 4×12 Greenback', volumeLitres: 170, sealed: true, description: 'G12M-25、密闭空气弹簧与分割振动滤波；部分单元参数与净容积为估计值。' },
  { id: 'marshall-1960b', name: 'Marshall 1960B · 4×12 G12T-75', volumeLitres: 180, sealed: true, description: 'G12T-75、密闭空气弹簧与分割振动滤波；部分单元参数与净容积为估计值。' },
  { id: 'vox-ac30c2', name: 'VOX AC30C2 · 2×12 Greenback', volumeLitres: 65, sealed: false, description: '两只 G12M-25 串联、开放背板；部分单元参数为估计值，不代表 Alnico Blue 版本。' },
  { id: 'mesa-rectifier', name: 'MESA Rectifier · 4×12 V30', volumeLitres: 200, sealed: true, description: 'V30 参考单元、密闭空气弹簧与分割振动滤波；不是 MESA 定制单元的实测响应。' },
  { id: 'orange-ppc412', name: 'Orange PPC412 · 4×12 V30', volumeLitres: 150, sealed: true, description: 'V30 参考单元与较小密闭容积；部分单元参数及净容积为估计值。' }
] as const)
export const isModeledAmp = (id: string): boolean => MODELED_AMPS.some(model => model.id === id)
export const isModeledCab = (id: string): boolean => MODELED_CABS.some(model => model.id === id)
