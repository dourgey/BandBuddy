export type EnsembleInstrument = 'drums' | 'piano' | 'keyboard'
export type DrumVoice = 'kick' | 'snare' | 'hat' | 'openHat' | 'pedal' | 'tom' | 'crash' | 'ride'
export interface EnsembleEvent {
 id: string; beat: number; duration: number; notes: number[]; hand?: 'R' | 'L'; drum?: DrumVoice; velocity: number; label?: string
}
export interface EnsembleScore {
 name: string; description: string; meter: string; beatUnit: number; bars: number; events: EnsembleEvent[]
}
export const DRUM_LABELS: Record<DrumVoice, string> = { kick: '底鼓', snare: '军鼓', hat: '闭镲', openHat: '开镲', pedal: '脚踩镲', tom: '通鼓', crash: '吊镲', ride: '叮叮镲' }
export const measureBeats = (meter: string): number => { const [n, d] = meter.split('/').map(Number); return n! * 4 / d! }
const event = (beat: number, duration: number, notes: number[], hand: 'R' | 'L' = 'R', velocity = .65): EnsembleEvent => ({ id: `${hand}-${beat}`, beat, duration, notes, hand, velocity })
const hit = (beat: number, drum: DrumVoice, label = '', velocity = .65): EnsembleEvent => ({ id: `${drum}-${beat}`, beat, duration: .25, notes: [], drum, velocity, label })
const score = (name: string, description: string, events: EnsembleEvent[], bars = 2, meter = '4/4', beatUnit = 1): EnsembleScore => ({ name, description, events, bars, meter, beatUnit })
function groove(bars = 4): EnsembleEvent[] {
 return Array.from({ length: bars }, (_, b) => [
  ...Array.from({ length: 8 }, (_, i) => hit(b * 4 + i / 2, 'hat', 'R', .4)),
  hit(b * 4, 'kick'), hit(b * 4 + 2, 'kick'), hit(b * 4 + 1, 'snare', 'L'), hit(b * 4 + 3, 'snare', 'L')
 ]).flat()
}
function hands(notes: number[], step = 1): EnsembleEvent[] { return notes.map((n, i) => event(i * step, step, [n])) }
const progression = [[60, 64, 67], [60, 64, 69], [60, 65, 69], [59, 62, 67]]
const rootNotes = [48, 45, 41, 43]
function chords(split = false): EnsembleEvent[] {
 return progression.flatMap((notes, b) => split ? notes.concat(notes[1]!).map((n, i) => event(b * 4 + i, 1, [n])) : [event(b * 4, 4, notes)])
}
function melody(): EnsembleEvent[] {
 return [64, 67, 64, 60, 64, 69, 64, 60, 65, 69, 65, 60, 62, 67, 65, 59].map((n, i) => event(i, 1, [n], 'R', .75))
}
function bass(): EnsembleEvent[] { return rootNotes.map((n, i) => event(i * 4, 4, [n], 'L', .35)) }
const simple = score('基础', '右手 C4–D4–E4–G4 / G4–E4–D4–C4，每拍一音。', hands([60, 62, 64, 67, 67, 64, 62, 60]))
/** Authored playable material only: tasks without a score retain their own task instructions. */
export function exerciseScores(id: string, instrument: EnsembleInstrument): EnsembleScore[] {
 if (id === 'P02-05' || id === 'C06-01' || id === 'C02-03' || id === 'D08-01') return [freshMaterial(instrument, 12345)]
 if (id === 'C01-01' || id === 'C01-05' || id === 'C02-01' || id === 'C02-02') {
  const base = instrument === 'drums' ? Array.from({ length: 8 }, (_, i) => hit(i, 'snare', i % 2 ? 'L' : 'R')) : hands(Array(8).fill(60))
  const half = base.filter((_, i) => i % 2 === 0)
  return [score('拍点', '每拍一个声音，连续两小节。', base), score('留出休止', '只在第 1、3 拍发声，其他拍继续内数。', half)]
 }
 if (id === 'C01-02') {
  return [1, .5, .25].map(step => score(step === 1 ? '四分' : step === .5 ? '八分' : '十六分', '拍速不变，只改变每拍的发音数量。三连音请先口数三等分单独练习。', Array.from({ length: 8 / step }, (_, i) => instrument === 'drums' ? hit(i * step, 'snare', i % 2 ? 'L' : 'R') : event(i * step, step, [60]))))
 }
 if (id === 'C03-01' || id === 'C03-05') return [instrument === 'drums' ? score('听觉短句', '先隐藏谱面聆听，再敲出军鼓节奏。', [hit(0, 'snare'), hit(1, 'snare'), hit(1.5, 'snare'), hit(3, 'snare')], 1) : score('听觉短句', '先隐藏谱面聆听，再唱或弹；第 4 拍留白。', hands([60, 64, 62]), 1)]
 if (id === 'C03-03') return [score('大三和弦', 'C–E–G，先听再说出性质。', [event(0, 4, [60, 64, 67])], 1), score('小三和弦', 'C–E♭–G，三音降低半音。', [event(0, 4, [60, 63, 67])], 1)]
 if (instrument === 'drums') {
  if (id === 'D01-01' || id === 'D01-02') return ['R', 'L'].map(hand => score(hand === 'R' ? '右手' : '左手', '单手每拍一击，观察回弹与相近落点，再换手比较。', Array.from({ length: 8 }, (_, i) => hit(i, 'snare', hand))))
  if (id === 'D01-03') return [.25, .55, .85].map((v, i) => score(['轻', '中', '强'][i]!, '保持单跳节奏与速度，只改变动态；听声音并观察击打高度。', Array.from({ length: 8 }, (_, i) => hit(i, 'snare', i % 2 ? 'L' : 'R', v))))
  if (/^D02-0[1234]$/.test(id)) {
   const order = id === 'D02-02' ? 'RRLL' : id === 'D02-03' ? 'RLRRLRLL' : 'RL'
   const base = Array.from({ length: 16 }, (_, i) => hit(i / 2, 'snare', order[i % order.length]!, id === 'D02-04' && i % 4 ? .3 : .7))
   return [score('基础手序', `八分音符连续两小节，手序 ${order}；R 右手，L 左手。`, base), id === 'D02-04' ? score('重音移位', '每四音组的重音从第一个音移到第二个音，其他音轻。', base.map((e, i) => ({ ...e, velocity: i % 4 === 1 ? .7 : .3 }))) : score('交换领奏', '保持节奏与鼓件，交换 R / L。', base.map(e => ({ ...e, label: e.label === 'R' ? 'L' : 'R' })))]
  }
  if (id === 'D03-01' || id === 'D03-02') return [score('底鼓', '底鼓第 1 拍、第 3 拍及第 3 拍后半拍；保留休止。', [hit(0, 'kick'), hit(2, 'kick'), hit(2.5, 'kick'), hit(4, 'kick'), hit(6, 'kick'), hit(6.5, 'kick')])]
  if (id === 'D03-04') {
   const events = groove(2).filter(e => !(e.drum === 'hat' && e.beat % 4 === 3.5))
   events.push(hit(3.5, 'openHat', 'R'), hit(7.5, 'openHat', 'R'), hit(0, 'pedal'), hit(4, 'pedal'))
   return [score('反拍开镲', '每小节第 4 拍后半拍开镲，下一小节第一拍脚踩闭合。', events)]
  }
  if (/^D04-0[123]$/.test(id) || /^D05-0[12345]$/.test(id) || /^D06-0[12345]$/.test(id)) {
   const events = groove()
   if (id === 'D06-01') for (let b = 0; b < 4; b++) events.push(hit(b * 4 + 1.75, 'snare', 'L', .2), hit(b * 4 + 2.5, 'snare', 'L', .2))
   let changed = events.filter(e => e.drum !== 'hat'), description = '移除镲片，单独核对底鼓与军鼓的关系。', name = '减少声部'
   if (id === 'D05-02' || id === 'D04-03') { changed = events.map(e => e.drum === 'kick' && e.beat % 4 === 2 ? { ...e, id: `${e.id}-off`, beat: e.beat + .5 } : e); name = '改变底鼓'; description = '每小节第二次底鼓从第 3 拍移到其后半拍，镲与军鼓保持原任务。' }
   if (id === 'D05-03') { changed = events.filter(e => e.drum !== 'hat' || Number.isInteger(e.beat)); name = '四分镲片'; description = '底鼓军鼓不变，只将镲片减少为四分音符。' }
   if (id === 'D05-05') { changed = events.filter(e => e.drum !== 'snare').concat(Array.from({ length: 4 }, (_, b) => hit(b * 4 + 2, 'snare', 'L'))); name = 'Half-time'; description = 'BPM 不变，军鼓改为每小节第 3 拍。' }
   if (id.startsWith('D06')) { changed = events.map(e => ({ ...e, velocity: id === 'D06-05' ? .2 + e.beat / 16 * .6 : Math.min(.95, e.velocity * 1.3) })); name = id === 'D06-05' ? '渐强' : '增强动态'; description = '节奏与长度保持不变，只调整力度；幽灵音仍保持较轻。' }
   return [score('基础律动', '闭镲八分、军鼓第 2 / 4 拍、底鼓第 1 / 3 拍。', events, 4), score(name, description, changed, 4)]
  }
  if (id === 'D05-06') return [score('三连音骨架', '每大拍第一、第三个八分位置击镲；第二大拍军鼓。此谱是 Shuffle 入门骨架，风格需结合录音。', [hit(0, 'hat'), hit(1, 'hat'), hit(1.5, 'hat'), hit(2.5, 'hat'), hit(0, 'kick'), hit(1.5, 'snare')], 1, '6/8', 1.5)]
  if (/^D07-0[123]$/.test(id)) {
   const start = id === 'D07-01' ? 15 : 14
   const events = groove().filter(e => e.beat < start)
   for (let beat = start; beat < 16; beat += .25) events.push(hit(beat, 'snare', Math.round((beat - start) * 4) % 2 ? 'L' : 'R'))
   return [score('军鼓加花', '四小节循环，末小节最后指定拍位加花；下一轮第一拍回到律动。', events, 4), score('移动到通鼓', '节奏、手序和回归点不变，最后一拍移至通鼓。', events.map(e => ({ ...e, drum: e.beat >= 15 ? 'tom' : e.drum })), 4)]
  }
  if (id === 'D10-01') return [score('2＋2＋3', '7/8；BPM 对应八分音符，重音落在第 1、3、5 个八分位置。', Array.from({ length: 7 }, (_, i) => hit(i / 2, 'snare', i % 2 ? 'L' : 'R', [0, 2, 4].includes(i) ? .8 : .3)), 1, '7/8', .5), score('3＋2＋2', '相同小节长度，重音改为第 1、4、6 个八分位置。', Array.from({ length: 7 }, (_, i) => hit(i / 2, 'snare', i % 2 ? 'L' : 'R', [0, 3, 5].includes(i) ? .8 : .3)), 1, '7/8', .5)]
  return []
 }
 if (id === 'P06-01') return [score('根音长音', '右手旋律＋左手 C3、A2、F2、G2 长音；先不用踏板。', [...melody(), ...bass()], 4), score('左手分解', '旋律保持不变，左手根音、五音、八度、五音。', [...melody(), ...rootNotes.flatMap((n, b) => [n, n + 7, n + 12, n + 7].map((p, i) => event(b * 4 + i, 1, [p], 'L', .3)))], 4)]
 if (id === 'K02-04' || id === 'K05-01') {
  const right = [[53, 60], [53, 59], [52, 59], [52, 59]].map((n, i) => event(i * 4, 4, n))
  return [score('独立伴奏', 'Dm7 → G7 → Cmaj7 → Cmaj7；右手三七音，左手补根音。', [...right, ...[38, 43, 36, 36].map((n, i) => event(i * 4, 4, [n], 'L', .4))], 4), score('有贝斯版本', '撤掉左手根音，让伴奏中的贝斯承担低音；右手保持相同连接。', right, 4)]
 }
 if (id === 'P03-01' || id === 'P03-02' || id === 'K01-01') return [score('上行', 'C 大调一八度；右手建议指法 1–2–3–1–2–3–4–5。', hands([60, 62, 64, 65, 67, 69, 71, 72])), score('下行', '从高音 C 返回，手指移动预先准备。', hands([72, 71, 69, 67, 65, 64, 62, 60]))]
 if (id === 'P03-06') return [score('三度模进', 'C–E、D–F、E–G、F–A；数字指级数，不是指法。', hands([60, 64, 62, 65, 64, 67, 65, 69]))]
 if (id === 'P04-02') return [score('转位上行', 'C–E–G → E–G–C → G–C–E → C–E–G，每组保持两拍。', [[60,64,67],[64,67,72],[67,72,76],[72,76,79]].map((n,i) => event(i * 2,2,n)))]
 if (id === 'K03-01') return [score('拍上触发', '只用 C 大三和弦，每拍一次，半拍后释放。', Array.from({length:8},(_,i)=>event(i,.5,[60,64,67]))), score('反拍触发', '仍用 C 和弦，起音移到每拍后半拍。', Array.from({length:8},(_,i)=>event(i+.5,.5,[60,64,67])))]
 if (id === 'K03-05' || id === 'K03-06') return [score('稀疏伴奏', 'C → Am → F → G；每小节第 1、3 拍触发，每次一拍后释放。', progression.flatMap((n,b)=>[event(b*4,1,n),event(b*4+2,1,n)]),4),score('增加触发', '同一进行，每小节四次触发；速度和段落保持不变。',progression.flatMap((n,b)=>Array.from({length:4},(_,i)=>event(b*4+i,.5,n))),4)]
 if (/^P04-0[146]$/.test(id) || /^K02-0[123]$/.test(id) || id === 'K03-02') return [score('长和弦', 'C → Am → F → G，每小节一个和弦，观察共同音。', chords(), 4), score('分解和弦', '和声顺序不变，每小节改为四次单音。', chords(true), 4)]
 if (/^P05-0[12345]$/.test(id)) return [score('左手长音', '左手 C3 持续四拍，右手每拍一音；两条声部保持各自时值。', [...simple.events, event(0, 4, [48], 'L', .3), event(4, 4, [43], 'L', .3)]), score('交换声部', '交换旋律与保持声部：低声部旋律降低一八度，高声部长音提高一八度。', [...simple.events.map(e => ({ ...e, id: `L-${e.beat}`, hand: 'L' as const, notes: e.notes.map(n => n - 12) })), event(0, 4, [60], 'R', .3), event(4, 4, [55], 'R', .3)])]
 if (id === 'P01-01') return [.25,.55,.85].map((v,i) => score(['轻','中','强'][i]!, '同一 C4，每拍一音；保持拍点，只改变声音层次。', Array.from({length:8},(_,i)=>event(i,1,[60],'R',v))))
 if (/^P01-0[24]$/.test(id) || id === 'P02-02' || id === 'P10-01') return [simple, { ...simple, name: '改变起点', description: '从后半句开始，保持相同拍号与音长。', events: hands([67, 64, 62, 60, 60, 62, 64, 67]) }]
 return []
}

export function freshMaterial(instrument: EnsembleInstrument, seed: number, chord = false): EnsembleScore {
 let state = seed >>> 0
 const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
 if (chord) {
  const root = 60 + Math.floor(random() * 6), minor = random() < .5
  return score('陌生和弦', `${['C','C♯','D','D♯','E','F'][root - 60]} ${minor ? '小' : '大'}三和弦；根音、${minor ? '小' : '大'}三度、纯五度。`, [event(0,4,[root,root+(minor?3:4),root+7])],1)
 }
 if (instrument === 'drums') return score('陌生节奏', '两小节军鼓节奏，空位保留休止；先数拍，再演奏。', Array.from({length:16},(_,i)=>hit(i/2,'snare',i%2?'L':'R')).filter((_,i)=>i===0 || random()>.3))
 const scale = [60,62,64,65,67]
 return score('陌生旋律', 'C 大调五音范围，两小节，每拍一音；第一次连续演奏后再核对。', hands(Array.from({length:8},()=>scale[Math.floor(random()*scale.length)]!)))
}
