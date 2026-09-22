import { z } from 'zod'
import { mod, type Tuning } from './theory.js'
import { meterLength, type GeneratedExercise } from './generator.js'
import type { ExerciseConfig, MusicEvent } from './types.js'

export const electricDefaults = () => ({ stage: 0, shift: 0 })
export const electricSchema = z.object({
  stage: z.number().int().min(0).max(2),
  shift: z.number().int().min(-5).max(7)
})
export type ElectricConfig = z.infer<typeof electricSchema>
type StringFret = [string: number, fret: number]
type Gesture = Omit<MusicEvent, 'id' | 'beat' | 'notes'> & { notes: StringFret[] }
interface ProjectStage {
  title: string
  task: string
  bars: Gesture[][]
}
export interface GuitarProject {
  id: string
  title: string
  category: '硬摇' | '朋克' | '后摇' | '数摇' | '机能项目'
  skill: string
  purpose: string
  tone: string
  check: string
  root: number
  scale: string
  bpm: number
  meter: '4/4' | '7/8'
  subdivision: number
  stages: [ProjectStage, ProjectStage, ProjectStage]
}
const n = (string: number, fret: number, duration = 0.5, extra: Partial<Gesture> = {}): Gesture => ({
  notes: [[string, fret]],
  duration,
  ...extra
})
const rest = (duration: number): Gesture => ({ notes: [], duration })
const chord = (notes: StringFret[], duration: number, extra: Partial<Gesture> = {}): Gesture => ({
  notes,
  duration,
  ...extra
})
const power = (fret: number, duration = 0.5, extra: Partial<Gesture> = {}): Gesture =>
  chord(
    [
      [6, fret],
      [5, fret + 2]
    ],
    duration,
    extra
  )
const stage = (title: string, task: string, ...bars: Gesture[][]): ProjectStage => ({ title, task, bars })
const alternate = (notes: StringFret[], duration = 0.5): Gesture[] =>
  notes.map(([s, f], i) => n(s, f, duration, { technique: i % 2 ? 'up' : 'down' }))
const ePedal = (count: number): Gesture[] =>
  Array.from({ length: count }, () => n(6, 0, 0.5, { palmMute: true }))
const tremolo = (fret: number, velocity: number): Gesture[] =>
  Array.from({ length: 8 }, (_, i) => n(1, fret, 0.5, { technique: i % 2 ? 'up' : 'down', velocity }))

// Original miniatures, authored in string/fret space. No book or song transcriptions.
// Every stage is bar-aligned; rests are explicit so notation and transport share one timeline.
export const GUITAR_PROJECTS: readonly GuitarProject[] = [
  {
    id: 'hard-riff',
    title: '引擎与刹车',
    category: '硬摇',
    skill: '低音踏板 · P.M. · 断奏',
    purpose: '把低音 E 当引擎，G5／A5 当路标；休止是 riff 的一部分。',
    tone: '实琴用中等增益，先关延迟。掌根靠近琴桥轻触低弦，仍要听出音高；换到开放强力和弦时稍放松。',
    check: '低音短而有音高，G5／A5 起音齐，停顿没有邻弦残响。',
    root: 4,
    scale: 'minor-pent',
    bpm: 68,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage(
        '拆解：踏板与空拍',
        '先只听低音长短，再弹 G5；第四拍留空。',
        [...ePedal(4), power(3, 1), rest(1)],
        [...ePedal(4), power(5, 1), rest(1)]
      ),
      stage(
        '组合：短音与开放音',
        '用 P.M. 制造层次；G5 不做掌根制音，句末主动收音。',
        [...ePedal(3), rest(0.5), power(3), power(5), rest(1)],
        [power(0, 1), ...ePedal(2), power(3), rest(0.5), power(0), rest(0.5)]
      ),
      stage(
        '应用：重音与回应',
        '保持第一拍的 E，第二小节用短促回答；不要在休止里追拍。',
        [...ePedal(2), power(3, 0.5, { accent: true }), rest(0.5), ...ePedal(2), power(5), rest(0.5)],
        [
          power(3, 0.5, { accent: true }),
          n(6, 0, 0.25, { palmMute: true }),
          n(6, 0, 0.25, { palmMute: true }),
          power(5),
          rest(0.5),
          power(0, 1),
          rest(1)
        ]
      )
    ]
  },
  {
    id: 'punk-drive',
    title: '八分音符列车',
    category: '朋克',
    skill: '下拨耐力 · 换和弦 · 收音',
    purpose: '让强力和弦有稳定推力，并把主歌与副歌的密度区分开。',
    tone: '先用清音确认双音，再逐步加失真。失真越多越要控制未用弦；大动作和高增益不是力度的替代品。',
    check: '换和弦前最后一音不缩短，肩膀放松，休止由双手共同完成。',
    root: 9,
    scale: 'minor-pent',
    bpm: 64,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage(
        '拆解：四发一停',
        '每小节四个下拨后休息两拍；每次回到同样的动作幅度。',
        [...Array.from({ length: 4 }, () => power(5, 0.5, { technique: 'down' })), rest(2)],
        [...Array.from({ length: 4 }, () => power(3, 0.5, { technique: 'down' })), rest(2)]
      ),
      stage(
        '组合：弦组换轨',
        'A5–C5–G5–D5，每个和弦一小节；只扫需要的两根弦。',
        ...(
          [
            [
              [6, 5],
              [5, 7]
            ],
            [
              [5, 3],
              [4, 5]
            ],
            [
              [6, 3],
              [5, 5]
            ],
            [
              [5, 5],
              [4, 7]
            ]
          ] as StringFret[][]
        ).map((shape) =>
          Array.from({ length: 8 }, (_, i) => chord(shape, 0.5, { technique: 'down', accent: i === 0 }))
        )
      ),
      stage(
        '应用：密度对比',
        '第一小节短奏，第二小节连续八分；保持同速，让能量来自编排。',
        [
          power(5, 0.5, { palmMute: true }),
          rest(0.5),
          power(5, 0.5, { palmMute: true }),
          rest(0.5),
          power(3, 0.5, { palmMute: true }),
          rest(0.5),
          power(3, 0.5, { palmMute: true }),
          rest(0.5)
        ],
        Array.from({ length: 8 }, (_, i) =>
          power(i < 4 ? 5 : 3, 0.5, { technique: i % 2 ? 'up' : 'down', accent: i === 0 || i === 4 })
        )
      )
    ]
  },
  {
    id: 'post-layers',
    title: '从一束光到声墙',
    category: '后摇',
    skill: '共同音 · 分解 · 动态弧线',
    purpose: '保留高音 E，让内声部变化；用密度与力度建立一个段落。',
    tone: '实琴先弹干声，再试低混合比延迟与混响。不要用尾音掩盖换和弦杂音。示范为干声参考；效果器参数在正文中给出。',
    check: '稀疏与密集版本仍有相同主拍；渐强没有变成加速。',
    root: 0,
    scale: 'major',
    bpm: 60,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage(
        '拆解：留白的轮廓',
        '听 C 和 Am 中共同的 E；一次只弹一个音，留出回应空间。',
        [n(3, 5, 1), n(2, 5, 1), n(1, 0, 1), rest(1)],
        [n(3, 5, 1), n(2, 5, 1), n(1, 5, 1), rest(1)]
      ),
      stage(
        '组合：共同音分解',
        'C–Am–Fmaj7（省五音）–G6 的简化配置；高音 E 保留，G 上形成六度色彩。谱例按分离音长示范，实琴再试延留。',
        ...(
          [
            [
              [3, 0],
              [2, 1],
              [1, 0]
            ],
            [
              [3, 2],
              [2, 1],
              [1, 0]
            ],
            [
              [4, 3],
              [3, 2],
              [1, 0]
            ],
            [
              [3, 0],
              [2, 0],
              [1, 0]
            ]
          ] as StringFret[][]
        ).map(([a, b, c]) => alternate([a!, b!, c!, b!, a!, b!, c!, b!]))
      ),
      stage(
        '应用：四小节动态弧',
        '八分重复音 C–D–E–D，力度弱→中→强→弱；不是用更快的拨弦制造高潮。',
        tremolo(8, 0.45),
        tremolo(10, 0.65),
        tremolo(12, 1),
        tremolo(10, 0.5)
      )
    ]
  },
  {
    id: 'math-grid',
    title: '七格积木',
    category: '数摇',
    skill: '7/8 · 2+2+3 · 切分',
    purpose: '先能唱出七个八分音符，再在 2+2+3 的分组里组织旋律。',
    tone: '清音或轻破音即可。BPM 按四分音符计，七个八分音符是一小节；这里没有把 3+3+2 的 4/4 错写成七拍。',
    check: '能持续口数“1 2／1 2／1 2 3”，回到下一小节不多等半拍。',
    root: 0,
    scale: 'major',
    bpm: 56,
    meter: '7/8',
    subdivision: 2,
    stages: [
      stage(
        '拆解：数七格',
        '重音在第 1、3、5 格；弱音不省略。',
        Array.from({ length: 7 }, (_, i) => n(2, 5, 0.5, { accent: [0, 2, 4].includes(i) })),
        Array.from({ length: 7 }, (_, i) => n(2, 5, 0.5, { accent: [0, 2, 4].includes(i) }))
      ),
      stage(
        '组合：旋律装入格子',
        '给每个分组一个轮廓，最后三格是完整的一组。',
        alternate([
          [3, 5],
          [2, 5],
          [1, 7],
          [2, 5],
          [3, 7],
          [2, 6],
          [1, 8]
        ]).map((e, i) => ({ ...e, accent: [0, 2, 4].includes(i) })),
        alternate([
          [3, 5],
          [2, 5],
          [1, 7],
          [2, 5],
          [3, 7],
          [2, 6],
          [1, 5]
        ]).map((e, i) => ({ ...e, accent: [0, 2, 4].includes(i) }))
      ),
      stage(
        '应用：空格仍占时间',
        '第二格与第六格休止；数数连续，剩下的音不挤到一起。',
        [
          n(3, 5, 0.5, { accent: true }),
          rest(0.5),
          n(2, 5, 0.5, { accent: true }),
          n(1, 7),
          n(2, 6, 0.5, { accent: true }),
          rest(0.5),
          n(1, 8)
        ],
        [
          n(3, 5, 0.5, { accent: true }),
          rest(0.5),
          n(2, 5, 0.5, { accent: true }),
          n(1, 7),
          n(2, 6, 0.5, { accent: true }),
          rest(0.5),
          n(1, 5)
        ]
      )
    ]
  },
  {
    id: 'finger-maze',
    title: '指序迷宫',
    category: '机能项目',
    skill: '指独立 · 动作经济 · 双手同步',
    purpose: '让 1–3–2–4 指序变成可控制的路径；正确按弦比手指抬得高更重要。',
    tone: '先清音。第 5–8 品对应食、中、无名、小指；手腕自然，不强迫手指悬空保持夸张伸展。',
    check: '每次只听见目标音，换弦前后拍点一样，没有靠挤压手腕完成跨度。',
    root: 9,
    scale: 'chromatic',
    bpm: 56,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage(
        '拆解：一条走廊',
        '一弦弹 5–7–6–8，然后倒序返回；保持交替拨弦。',
        alternate([
          [1, 5],
          [1, 7],
          [1, 6],
          [1, 8],
          [1, 8],
          [1, 6],
          [1, 7],
          [1, 5]
        ])
      ),
      stage(
        '组合：两条走廊',
        '保留指序，加入换弦；提前看下一根弦。',
        alternate([
          [2, 5],
          [2, 7],
          [2, 6],
          [2, 8],
          [1, 5],
          [1, 7],
          [1, 6],
          [1, 8]
        ]),
        alternate([
          [1, 8],
          [1, 6],
          [1, 7],
          [1, 5],
          [2, 8],
          [2, 6],
          [2, 7],
          [2, 5]
        ])
      ),
      stage(
        '应用：把半音带回旋律',
        '先四音半音片段，再用 A 小调音回答；听清 B♭、B 如何走向 C。',
        [
          ...alternate(
            [
              [1, 5],
              [1, 6],
              [1, 7],
              [1, 8]
            ],
            0.25
          ),
          n(1, 7, 0.5),
          n(1, 5, 0.5),
          n(2, 8, 1),
          rest(1)
        ],
        [n(2, 5), n(1, 5), n(1, 8), n(1, 7), n(1, 5, 1), rest(1)]
      )
    ]
  },
  {
    id: 'string-courier',
    title: '跨弦快递',
    category: '机能项目',
    skill: '内外侧拨弦 · 跨弦 · 制音',
    purpose: '把同一组音用不同起拨方向运送，观察拨片如何离开弦面。',
    tone: '清音、短音长。手掌和左手空闲部分轻触未用弦；拨片进入弦的深度尽量一致。',
    check: '跳过的弦没有响，换弦处没有多出一个重音；能说出当前起拨方向。',
    root: 0,
    scale: 'major',
    bpm: 56,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage(
        '拆解：相邻站点',
        '第 1 小节下拨起，第 2 小节上拨起；比较换弦时内侧和外侧动作。',
        alternate(Array.from({ length: 8 }, (_, i) => (i % 2 ? [2, 5] : [3, 5]))),
        alternate(Array.from({ length: 8 }, (_, i) => (i % 2 ? [2, 5] : [3, 5]))).map((e, i) => ({
          ...e,
          technique: i % 2 ? 'down' : 'up'
        }))
      ),
      stage(
        '组合：跳过一站',
        'D 弦 F 与 B 弦 E 跨弦交替，G 弦保持安静。',
        alternate(Array.from({ length: 8 }, (_, i) => (i % 2 ? [2, 5] : [4, 3])))
      ),
      stage(
        '应用：Cmaj7 快递线',
        '运送 C–G–E–B，听琶音关系；动作服务和弦线条。',
        alternate([
          [5, 3],
          [3, 0],
          [4, 2],
          [2, 0],
          [5, 3],
          [3, 0],
          [4, 2],
          [2, 0]
        ]),
        [n(1, 0), n(3, 0), n(2, 1, 1), rest(2)]
      )
    ]
  },
  {
    id: 'silence-sniper',
    title: '静音狙击',
    category: '机能项目',
    skill: '短音 · 休止 · 节奏爆发',
    purpose: '练习“停在正确位置”，让失真下的空拍也清楚可辨。',
    tone: '先低增益检查收音，再换常用音色。休止时释放按弦压力并轻触弦，不猛抬整只手。',
    check: '短促片段后能立即安静，下一次起音准时；休止没有被自动缩短。',
    root: 4,
    scale: 'minor-pent',
    bpm: 60,
    meter: '4/4',
    subdivision: 4,
    stages: [
      stage(
        '拆解：两响两停',
        '四分拍中只弹前半拍；先数完整十六分网格。',
        Array.from({ length: 4 }, () => [
          n(6, 0, 0.25, { palmMute: true }),
          n(6, 0, 0.25, { palmMute: true }),
          rest(0.5)
        ]).flat()
      ),
      stage(
        '组合：三发后归零',
        '每拍三个十六分音符加一个十六分休止；最后一音不要拖过边界。',
        Array.from({ length: 4 }, () => [
          ...Array.from({ length: 3 }, () => n(6, 0, 0.25, { palmMute: true })),
          rest(0.25)
        ]).flat()
      ),
      stage('应用：riff 中的刹车', '把短促片段接 G5／A5；不要在和弦之前额外补一个低音。', [
        n(6, 0, 0.25, { palmMute: true }),
        n(6, 0, 0.25, { palmMute: true }),
        rest(0.5),
        power(3, 0.5, { gate: 0.45 }),
        rest(0.5),
        n(6, 0, 0.25, { palmMute: true }),
        n(6, 0, 0.25, { palmMute: true }),
        rest(0.5),
        power(5, 0.5, { gate: 0.45 }),
        rest(0.5)
      ])
    ]
  },
  {
    id: 'accent-shift',
    title: '重音换轨',
    category: '机能项目',
    skill: '3+3+2 · 弱拍重音 · 稳定主拍',
    purpose: '在不变的 4/4 中改变八分音符重音；分组长度不等于拍号变化。',
    tone: '清音先区分强弱，手部动作不随重音变大太多。节拍器依然提示四分拍。',
    check: '能同时用脚保持四拍、用手弹 3+3+2；重音落在第 1、4、7 个八分音符。',
    root: 9,
    scale: 'minor-pent',
    bpm: 60,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage(
        '拆解：一音三组',
        '同音先弹 3+3+2，再弹 2+2+2+2，对照听。',
        Array.from({ length: 8 }, (_, i) =>
          n(1, 5, 0.5, { accent: [0, 3, 6].includes(i), velocity: [0, 3, 6].includes(i) ? 1 : 0.5 })
        ),
        Array.from({ length: 8 }, (_, i) =>
          n(1, 5, 0.5, { accent: i % 2 === 0, velocity: i % 2 === 0 ? 1 : 0.5 })
        )
      ),
      stage(
        '组合：重音带旋律',
        'A–C–D–E–D–C–A–G，不改变每音时值，只改变 1、4、7 的重音。',
        alternate([
          [1, 5],
          [1, 8],
          [2, 3],
          [2, 5],
          [2, 3],
          [3, 5],
          [3, 2],
          [4, 5]
        ]).map((e, i) => ({ ...e, accent: [0, 3, 6].includes(i), velocity: [0, 3, 6].includes(i) ? 1 : 0.5 }))
      ),
      stage('应用：切分回应', '将部分弱音替换为休止，三组重音仍在原位置。', [
        n(1, 5, 0.5, { accent: true }),
        n(1, 8),
        rest(0.5),
        n(2, 5, 0.5, { accent: true }),
        n(2, 3),
        rest(0.5),
        n(3, 2, 0.5, { accent: true }),
        rest(0.5)
      ])
    ]
  },
  {
    id: 'legato-relay',
    title: '连奏接力',
    category: '机能项目',
    skill: '击弦 · 勾弦 · 音量平衡',
    purpose: '让起拨、击弦和勾弦传递同一个节奏，不因少拨几下而模糊拍点。',
    tone: '低增益；击弦落在品丝后，勾弦用小幅度离弦动作，避免拉偏音高。',
    check: 'h／p 连接的两音在同一根弦上；不用右手补拨也能保持清楚的起音。',
    root: 9,
    scale: 'minor-pent',
    bpm: 56,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage('拆解：击与勾', '先拨 A 击到 C，再拨 C 勾回 A；弧线起点 h／p 表示接往下一个音。', [
        n(1, 5, 0.5, { technique: 'hammer' }),
        n(1, 8),
        rest(1),
        n(1, 8, 0.5, { technique: 'pull' }),
        n(1, 5),
        rest(1)
      ]),
      stage('组合：跨弦接力', '每组第一音拨弦；离开旧弦前收音，下一弦接入同一细分。', [
        n(2, 5, 0.5, { technique: 'hammer' }),
        n(2, 8, 0.5, { technique: 'pull' }),
        n(2, 5),
        rest(0.5),
        n(1, 5, 0.5, { technique: 'hammer' }),
        n(1, 8, 0.5, { technique: 'pull' }),
        n(1, 5),
        rest(0.5)
      ]),
      stage('应用：句末落点', '接力后用 D–C–A 回答，重心回到长音 A。', [
        n(2, 5, 0.25, { technique: 'hammer' }),
        n(2, 8, 0.25, { technique: 'pull' }),
        n(2, 5, 0.5),
        n(1, 5, 0.25, { technique: 'hammer' }),
        n(1, 8, 0.25, { technique: 'pull' }),
        n(1, 5, 0.5),
        n(2, 3),
        n(3, 5),
        n(3, 2, 1)
      ])
    ]
  },
  {
    id: 'triad-corridor',
    title: '三和弦走廊',
    category: '机能项目',
    skill: '转位 · 经济拨弦 · 分离音长',
    purpose: '先找三和弦构成音，再把相邻弦上的音连接；扫拨也必须逐音发声。',
    tone: '清音先逐音停靠。食指小横按处轻微滚动释放上一弦压力，不让三个音无意糊成和弦。',
    check: '能说出 C、E、G；每个音单独清楚，回程无需突然加速。',
    root: 0,
    scale: 'major',
    bpm: 52,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage('拆解：逐间走过', 'C 第一转位 E–G–C：三弦 9、二弦 8、一弦 8；每音一拍。', [
        n(3, 9, 1),
        n(2, 8, 1),
        n(1, 8, 1),
        rest(1)
      ]),
      stage('组合：同向拨弦', '下行拨片依次经过三根弦，回程上拨；每个音仍占半拍。', [
        n(3, 9, 0.5, { technique: 'down' }),
        n(2, 8, 0.5, { technique: 'down' }),
        n(1, 8, 0.5, { technique: 'down' }),
        rest(0.5),
        n(1, 8, 0.5, { technique: 'up' }),
        n(2, 8, 0.5, { technique: 'up' }),
        n(3, 9, 0.5, { technique: 'up' }),
        rest(0.5)
      ]),
      stage(
        '应用：C 到 Am',
        '最高 C 保持不变，中声部 G 到 A；边弹边听和弦性质变化。',
        [n(3, 9), n(2, 8), n(1, 8), n(2, 8), n(3, 9), n(2, 10), n(1, 8), n(2, 10)],
        [n(3, 9), n(2, 8), n(1, 8, 1), rest(2)]
      )
    ]
  },
  {
    id: 'bend-target',
    title: '推弦靶心',
    category: '机能项目',
    skill: '目标音 · 全音推弦 · 乐句落点',
    purpose: '先建立目标音的听觉记忆，再推弦抵达它；不用推弦幅度代替听音。',
    tone: '琴弦张力应适合自己，轻到中等增益。无名指推弦时可用前两指支撑；出现不适就停下调整动作。',
    check: '全音推弦从 G 到 A，参考音是一弦 5 品；到达目标后不继续升高。',
    root: 9,
    scale: 'minor-pent',
    bpm: 52,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage('拆解：先听靶心', '第一拍 A 参考音，第三拍二弦 8 品 G 推全音到 A；比较终点。', [
        n(1, 5, 1),
        rest(1),
        n(2, 8, 1, { technique: 'bend', bend: 2 }),
        rest(1)
      ]),
      stage(
        '组合：留住终点',
        '推音占两拍；听示范的上升与目标，实琴保持到收音后再松弦。',
        [n(1, 5, 1), rest(1), n(2, 8, 2, { technique: 'bend', bend: 2 })],
        [n(2, 8, 2, { technique: 'bend', bend: 2 }), n(1, 5, 1), rest(1)]
      ),
      stage(
        '应用：问句与回答',
        '第一小节以推音提出问题，第二小节 C–A–G–E 用下行回答。',
        [n(2, 5), n(2, 8), n(2, 8, 2, { technique: 'bend', bend: 2 }), rest(1)],
        [n(1, 8), n(1, 5), n(2, 8), n(2, 5, 1), rest(1.5)]
      )
    ]
  },
  {
    id: 'two-hand-puzzle',
    title: '双手拼图',
    category: '机能项目',
    skill: '点弦 · 勾弦 · 双手制音',
    purpose: '用 A–C–E 三和弦安排双手接力，把高音点弦作为旋律音。',
    tone: '先清音或轻破音，双手轻触未用弦。T 表示右手点弦的该音；h／p 标在连接起点。',
    check: '一弦 12 品 E 由右手点出；右手离开时能清楚接回左手 C，其他弦安静。',
    root: 9,
    scale: 'minor-pent',
    bpm: 48,
    meter: '4/4',
    subdivision: 2,
    stages: [
      stage('拆解：两块拼图', '先左手 A，再右手点 E，单独听清两个起音。', [
        n(1, 5, 1),
        n(1, 12, 1, { technique: 'tap' }),
        rest(2)
      ]),
      stage('组合：三和弦接力', 'A 击 C，右手点 E 后回到 C；T 音离弦以小幅度勾弦带出后音。', [
        n(1, 5, 0.5, { technique: 'hammer' }),
        n(1, 8),
        n(1, 12, 0.5, { technique: 'tap' }),
        n(1, 8, 0.5, { technique: 'pull' }),
        n(1, 5, 1),
        rest(1)
      ]),
      stage('应用：末音变奏', '第一组点 E，第二组点 G；右手只换目标品，左手节奏和按弦位置不变。', [
        n(1, 5, 0.5, { technique: 'hammer' }),
        n(1, 8),
        n(1, 12, 0.5, { technique: 'tap' }),
        n(1, 8),
        n(1, 5, 0.5, { technique: 'hammer' }),
        n(1, 8),
        n(1, 15, 0.5, { technique: 'tap' }),
        n(1, 8)
      ])
    ]
  }
]

export function projectConfig(
  project: GuitarProject,
  c: ExerciseConfig,
  settings: ElectricConfig,
  capo: number
): ExerciseConfig {
  const frets = project.stages[settings.stage]!.bars.flat().flatMap((e) =>
    e.notes.map(([, f]) => f + settings.shift)
  )
  return {
    ...c,
    root: mod(project.root + settings.shift + capo),
    scale: project.scale,
    chord: project.scale === 'major' ? 'major' : 'minor',
    material: 'scale',
    pattern: 'scale',
    meter: project.meter,
    subdivision: project.subdivision,
    swing: 0.5,
    strings: [],
    minFret: Math.max(0, Math.min(...frets) - 1),
    maxFret: Math.max(...frets) + 1,
    backbeat: false,
    backing: 'drone',
    bass: 0,
    harmony: 0
  }
}
export function guitarProjectExercise(
  project: GuitarProject,
  tuning: Tuning,
  capo: number,
  settings: ElectricConfig
): GeneratedExercise {
  const standard = [40, 45, 50, 55, 59, 64]
  if (
    tuning.instrument !== 'guitar' ||
    tuning.notes.length !== 6 ||
    tuning.notes.some((n, i) => n !== standard[i])
  )
    throw new Error(
      '本项目的指法与和声针对六弦吉他标准调弦 E2 A2 D3 G3 B3 E4，请切换标准调弦；Drop D 与自定义调弦请在指板实验室探索。'
    )
  if (!electricSchema.safeParse(settings).success) throw new Error('项目参数无效，请重置练习参数。')
  const length = meterLength(project.meter)
  const bars = project.stages[settings.stage]!.bars
  const events: MusicEvent[] = []
  bars.forEach((bar, b) => {
    let beat = b * length
    bar.forEach((gesture, i) => {
      const notes = gesture.notes.map(([string, original]) => {
        const fret = original + settings.shift
        if (fret < 0 || fret + capo > tuning.frets)
          throw new Error('当前移位或变调夹超出可演奏品位。请减小移位／变调夹，或恢复原位。')
        return { string, fret, midi: tuning.notes[6 - string]! + capo + fret }
      })
      events.push({ ...gesture, id: `gp-${project.id}-${settings.stage}-${b}-${i}`, beat, notes })
      beat += gesture.duration
    })
    if (Math.abs(beat - (b + 1) * length) > 1e-6) throw new Error('项目谱例小节时值不完整。')
  })
  return { events, bars: bars.length, beats: bars.length * length }
}
export const ELECTRIC_SOURCES = [
  {
    label: '宫胁俊郎 · ギター基礎トレ365日！官方目录',
    url: 'https://www.rittor-music.co.jp/product/detail/3124217114/index.php'
  },
  {
    label: '小林信一 · 地獄のメカニカル・トレーニング・フレーズ 官方目录',
    url: 'https://www.rittor-music.co.jp/product/detail/3124217107/'
  },
  {
    label: 'Fender · Punk Power Chords',
    url: 'https://www.fender.com/articles/chords/punk-chords-all-power-see-how'
  },
  { label: 'BOSS · Delay Glossary', url: 'https://articles.boss.info/the-delay-pedal-glossary/' },
  {
    label: 'Guitar Center · Yvette Young 访谈',
    url: 'https://www.guitarcenter.com/riffs/interviews/guitars/guitar-center-podcast-s2-e7-yvette-young'
  }
]
