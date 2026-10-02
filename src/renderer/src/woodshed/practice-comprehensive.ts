import type { Instrument } from './theory.js'
import type { PracticeExercise, PracticeMeter, PracticeVariant, PracticeStage } from './practice-curriculum.js'

interface Segment {
  source?: string
  variant?: number
  name?: string
  cue?: string
  score?: string
  bars?: number
}
interface Plan { title: string; focus: string; segments: Segment[]; waltz?: Segment[] }
const from = (source: string, variant = 0, name?: string, cue?: string, bars = 4): Segment => ({ source, variant, name, cue, bars })
const phrase = (name: string, cue: string, score: string, bars = 4): Segment => ({ name, cue, score, bars })
const both = (source: string): Segment[] => [from(source), from(source, 1)]
const four = (string: number, fret: number): string => [0, 1, 2, 3, 3, 2, 1, 0].map(n => `${string}:${fret + n}`).join(' ')
const cross = (fret: number): string => `3:${fret} 2:${fret + 1} 3:${fret + 2} 2:${fret + 3} 2:${fret + 3} 3:${fret + 2} 2:${fret + 1} 3:${fret}`

// Plans deliberately specify order, contrasts and transfer tasks for each module.
// Source motifs retain their exact notation; repetitions always preserve a complete phrase.
const PLANS: Record<string, Plan> = {
  'guitar-01': {
    title: '放松、换弦与换把综合练习', focus: '保持最小按弦压力，在换弦、换把和手指排列变化时维持均匀发音。',
    segments: [from('pressure', 1, '按弦与放松'),
      phrase('不同弦上的四指顺序', '第一、第二、第三弦分别做 5–6–7–8 及倒序，每两小节换弦；一指一品。', [1, 2, 3].map(s => four(s, 5)).join(' '), 6),
      phrase('不同把位的四指顺序', '在第一弦依次使用第三、第五、第七把位；换把前减压，每两小节移动。', [3, 5, 7].map(f => four(1, f)).join(' '), 6),
      from('four-fingers', 1, '四指排列变化'),
      phrase('跨弦与换把协调', '在第三、第二弦交替落指，分别使用第三、第五、第七把位；旧弦按时止音。', [3, 5, 7].map(cross).join(' '), 6),
      from('cross-fingers', 0, '回到第五把位检查')]
  },
  'guitar-02': { title: '交替拨弦与换弦综合练习', focus: '从固定左手到每弦两音、每弦一音，换弦不多拨也不停顿。', segments: [...both('alternate'), ...both('string-change')] },
  'guitar-03': { title: '休止、切分与 Shuffle 综合练习', focus: '在同一基本拍内切换直八分、跨拍、弱起、三连音与长短律动。', segments: [...both('offbeat'), ...both('syncopation'), ...both('shuffle')] },
  'guitar-04': { title: '音长、制音与动态综合练习', focus: '分别听清休止、闷音和长音；四个阶段依次轻、中、强、中演奏，力度变化不改变起音点。', segments: [...both('muting'), from('dynamics', 0, '中强动态短句', '前两小节中等力度，后两小节较强；保持同样的拍点。'), from('dynamics', 1, '长短音收束', '回到中等力度，长音完整保持，休止主动制音。')] },
  'guitar-05': { title: '音名、八度与异弦同音综合练习', focus: '先说出实际音名和八度，再找位置；将地图用于跨音区连接。', segments: [...both('note-map'),
    phrase('跨音区 C 音连接', 'C3、C4、C5 往返；第三弦五品与第二弦一品都是 C4。', '5:3 3:5 1:8 2:1 5:3/2 1:8/2'),
    phrase('同音 A 的旋律接续', '第一弦五品与第二弦十品都是 A4；接 B4 后回 A4，比较两条路线。', '1:5 1:7 2:10/2 2:10 2:12 1:5/2')] },
  'guitar-06': { title: '旋律音程与双音综合练习', focus: '将同根大小三度的听辨移到 F，再比较先后弹与同时发声。', segments: [...both('intervals'),
    phrase('F 的大小三度', '第四弦 F3–A♭3–F3–A3，对比三与四个半音。', '4:3 4:6 4:3 4:7'),
    phrase('F 三度双音对照', '第四弦三品 F 与第三弦一品 A♭、二品 A 同响，根音保持不变。', '4:3+3:1/2 4:3+3:2/2')] },
  'guitar-07': { title: '音阶、调式与五声色彩综合练习', focus: '每组对照保持相同节奏，辨认调性中心与三、六、七级变化。', segments: [...both('scale'), ...both('pentatonic'), ...both('parallel-minor'), ...both('dorian'), ...both('major-blues')] },
  'guitar-08': { title: '顺阶、三度与精确移调综合练习', focus: '保持四分音符大拍，区分组内方向、调内距离与整体半音移调。', segments: [...both('sequence'), from('thirds'), ...both('chromatic-sequence')] },
  'guitar-09': { title: '和弦转换与转位综合练习', focus: '先稳定 Em–Am 的转换，再保持 C 大三和弦组成音进行转位连接。', segments: [...both('chord-change'), from('triads'),
    phrase('C 转位返回', '由高音区返回开放弦组；每个转位两拍，末两拍休止并制音。', '3:9+2:8+1:8/2 3:5+2:5+1:3/2 3:0+2:1+1:0/2 -/2')] },
  'guitar-10': { title: '琶音入口与七音色彩综合练习', focus: '根音和三音进入后，对比 Cmaj7 与 C7，连接中仍能辨认和弦内音。', segments: [...both('arpeggio'), ...both('seventh-colour')] },
  'guitar-11': { title: '推弦、击勾与双音综合练习', focus: '推弦先核对目标，再连接击勾弦和双音回应；不同发音方式保留同一拍点。', segments: [...both('bend'), ...both('legato'), ...both('blues-double-stop')] },
  'guitar-12': { title: '听、唱与找音综合练习', focus: '单音到三音，再听两种不同轮廓；空白小节只模唱并保持拍数。', segments: [...both('sing'),
    phrase('两种轮廓的模唱', '先弹 C–E–D，再空一小节模唱；接 E–D–C，再空一小节。下一轮先唱再弹核对。', '3:5 2:5 3:7 - -/4 2:5 3:7 3:5 - -/4', 8)] },
  'guitar-13': { title: '读谱、入口与记忆综合练习', focus: '先读两种入口，再读新四小节乐句；下一轮减少看谱，检查音长与休止。', segments: [...both('sight-read'),
    phrase('四小节连续阅读', 'C–D–E 起句，F–E 回应，再接 D–E–F–D，以 C 两拍和两拍休止结束。第二遍尝试凭记忆演奏。', '2:1/2 2:3 1:0 1:1 1:0 2:1/2 2:3 1:0 1:1 2:3 2:1/2 -/2', 8)] },
  'guitar-14': { title: '和声声部与疏密编配综合练习', focus: '同一 C–Am–F–G 进行先弹三和弦，再只弹最高音，最后交替使用两种密度。', segments: [...both('voice-leading'),
    phrase('和弦与旋律交替', 'C、F 小节弹三和弦，Am、G 小节只弹最高音；和声每四拍转换一次。', '3:5+2:5+1:3/4 1:5/4 3:5+2:6+1:5/4 1:3/4', 8)] },
  'guitar-15': { title: '动机发展与目标音综合练习', focus: '保留三音动机的问答关系，再为 C–F 选择准时到达的和弦内音。', segments: [...both('motif'), ...both('target-tones')] },
  'guitar-16': { title: '连续演奏、曲式与结尾综合练习', focus: '四小节连续与失误恢复后，完成标准和 Quick change 两轮曲式，区分引回与收束。', segments: [...both('continuous'), ...both('blues-form'), ...both('blues-ending')] },
  'guitar-17': { title: '音色比较与延迟节奏综合练习', focus: '固定演奏条件比较拾音器和增益，再用密集与留白两种节奏听延迟。设备参数在练习前或暂停后调整。', segments: [...both('tone-test'), ...both('delay')] },
  'guitar-18': { title: '录音、双轨与回听综合练习', focus: '用自己的录音设备记录短句与完整声部，再独立重弹一遍；回听时分别检查节奏、制音和音准。', segments: [from('record-review', 0, '短句录音'), from('record-review', 1, '完整声部第一遍'), from('record-review', 1, '完整声部独立重弹', '重新演奏作为第二轨；两遍使用相同速度，保留真实动作差异。', 8)] },
  'bass-01': { title: '发音、弦序与制音综合练习', focus: '将按弦放松、空弦辨认、两指交替和跨弦停止串成一轮；长短音都保持干净音尾。', segments: [from('pressure', 1), ...both('open-strings'), ...both('alternating'), ...both('cross-mute'), ...both('length')] },
  'bass-02': { title: '弱拍、幽灵音与律动综合练习', focus: '区分实音、幽灵音与休止，跨拍保持后进入两小节律动，再加末拍连接。', segments: [...both('offbeat'), ...both('ghost'), ...both('groove')] },
  'bass-03': { title: '根音、八度与调性综合练习', focus: '以根音骨架连接同音换位、八度、根五和大小调旋律；每次换弦同时结束旧音。', segments: [from('roots'), ...both('note-map'), ...both('octave'), from('fifths', 1), ...both('scale'), ...both('minor')] },
  'bass-04': { title: '趋近、琶音与指定低音综合练习', focus: '先用半音指向下一根音，再辨认七和弦三音、四拍路径和斜线和弦指定低音。', segments: [from('approach'), ...both('arpeggio'), ...both('walking'), ...both('slash')] },
  'bass-05': { title: '拨片、击勾与模唱综合练习', focus: '按阶段使用拨片、Slap/Pop、击勾和滑音，最后模唱低音轮廓；切换前可暂停准备。', segments: [...both('pick'), ...both('slap'), ...both('legato'), ...both('sing')] },
  'bass-06': { title: '编配、填充与录音综合练习', focus: '同一段落先根音再根五，比较骨架与末句填充；用固定短句检查音色并另行录音回听。', segments: [...both('arrange'), ...both('form'), from('tone'), from('record')] },
  'ukulele-01': { title: '高 G、拨奏与停止综合练习', focus: '保持高 G 的实际音高关系，将轻按、逐弦拨奏和主动制音连起来。', segments: [...both('pressure'), ...both('tuning'), ...both('finger'), ...both('stop')] },
  'ukulele-02': { title: '换和弦、空扫与弱拍综合练习', focus: '逐步缩短 C–Am 与 F–G 的转换间隔，加入空扫和后半拍，右手保持稳定运动。', segments: [...both('chords'), ...both('change'), ...both('strum'), ...both('offbeat')] },
  'ukulele-03': { title: '旋律定位、双音与连接综合练习', focus: '从大小调短句到同音换位、调内三度和击勾滑音，按实际音高理解旋律。', segments: [...both('melody'), ...both('note-map'), ...both('minor'), ...both('thirds'), ...both('legato')] },
  'ukulele-04': { title: '分解、七音与和弦旋律综合练习', focus: '将分解和弦、七音听辨、横按检查和旋律声部组合，保持高 G 弦音量受控。', segments: [...both('arpeggio'), ...both('sevenths'), ...both('barre'), ...both('chord-melody')] },
  'ukulele-05': { title: '问答、动机与风格综合练习', focus: '四拍版连接问答、五声动机和闷扫；三拍版另成一轮，比较长音、逐拍与留白伴奏。', segments: [from('question'), ...both('pentatonic'), from('chuck')],
    waltz: [...both('waltz'),
      phrase('三拍问答', 'C–D–E 一小节，空一小节模唱；E–D–C 回应，再空一小节。', '3:0 3:2 2:0 -/3 2:0 3:2 3:0 -/3'),
      phrase('三拍留白伴奏', 'C 与 Am 各三拍，只在第一拍发声一拍，后两拍止音；保持三个基本拍。', '4:0+3:0+2:0+1:3 -/2 4:2+3:0+2:0+1:0 -/2')] },
  'ukulele-06': { title: '完整伴奏、收束与收音综合练习', focus: '完成 C–Am–F–G，比较稀疏和逐拍编配，以固定分解句检查收音，最后练 G7 回 C 的收束。', segments: [from('progression'), ...both('arrange'), from('tone'), ...both('ending')] }
}

export function buildComprehensiveExercises(
  sources: readonly PracticeExercise[],
  parseScore: (instrument: Instrument, text: string, meter: PracticeMeter) => Pick<PracticeVariant, 'events' | 'beats' | 'meter'>
): PracticeExercise[] {
  const result: PracticeExercise[] = []
  for (const instrument of ['guitar', 'bass', 'ukulele'] as const) {
    const modules = [...new Set(sources.filter(e => e.instrument === instrument).map(e => e.module))]
    for (const module of modules) {
      const key = `${instrument}-${module.slice(0, 2)}`
      const plan = PLANS[key]
      if (!plan) throw new Error(`缺少版块综合练习规划：${key}`)
      const members = sources.filter(e => e.instrument === instrument && e.module === module)
      const sourceIds = new Set<string>()
      const compose = (segments: Segment[], meter: PracticeMeter, name: string): PracticeVariant => {
        const events: PracticeVariant['events'] = []
        const stages: PracticeStage[] = []
        const beatsPerBar = Number(meter.split('/')[0])
        let cursor = 0
        for (const segment of segments) {
          const source = segment.source ? members.find(e => e.id === `${instrument}-${segment.source}`) : undefined
          if (segment.source && !source) throw new Error(`综合练习引用了版块外的内容：${key}/${segment.source}`)
          const motif = source ? source.variants[segment.variant ?? 0] : parseScore(instrument, segment.score!, meter)
          if (!motif || motif.meter !== meter) throw new Error(`综合练习拍号或变体不匹配：${key}/${segment.source}`)
          if (source) sourceIds.add(source.id)
          const startBar = cursor / beatsPerBar + 1
          const repeats = Math.ceil((segment.bars ?? 4) * beatsPerBar / motif.beats)
          for (let repeat = 0; repeat < repeats; repeat++) {
            for (const event of motif.events) events.push({ ...event, notes: event.notes.map(n => ({ ...n })), id: `comprehensive-${events.length}`, beat: cursor + event.beat })
            cursor += motif.beats
          }
          const variant = source?.variants[segment.variant ?? 0]
          stages.push({ name: segment.name ?? `${source!.title} · ${variant!.name}`, description: segment.cue ?? variant!.description, startBar, endBar: cursor / beatsPerBar })
        }
        return { name, description: `${plan.focus} 本轮 ${cursor / beatsPerBar} 小节，按下方阶段顺序连续练习。`, events, beats: cursor, meter, stages }
      }
      const variants = [compose(plan.segments, '4/4', plan.waltz ? '四拍综合' : '完整综合')]
      if (plan.waltz) variants.push(compose(plan.waltz, '3/4', '三拍综合'))
      if (members.some(e => !sourceIds.has(e.id))) throw new Error(`综合练习未覆盖版块全部练习：${key}`)
      result.push({ id: `${key}-comprehensive`, instrument, module, title: `综合练习 · ${plan.title}`, kind: 'comprehensive', sourceIds: [...sourceIds],
        bpm: Math.min(...members.map(e => e.bpm)), variants, explanation: `${plan.focus} 先分别熟悉本版块的单项练习，再从舒适速度连续完成综合轮次；阶段切换不额外增加小节，需要准备时可以停止后重新开始。`,
        milestones: ['完整完成全部阶段，音符、休止与阶段交界的小节数准确。', '连续两轮保持相同速度；换弦、换把或换节奏时不额外停顿。', '录下完整一轮，按阶段指出一个具体问题；再把本版块目标用于自己的音乐片段。'],
        knowledge: [...new Set(members.flatMap(e => e.knowledge))] })
    }
  }
  return result
}
