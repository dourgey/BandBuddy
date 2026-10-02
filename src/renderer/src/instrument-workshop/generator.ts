import { CHORDS, SCALES, mod, positions, chordVoicings, type Tuning, type Position } from './theory.js'
import type { ExerciseConfig, MusicEvent, Technique } from './types.js'
export const meterLength = (meter: string): number => {
  const [n, d] = meter.split('/').map(Number)
  return (n! * 4) / d!
}
export const beatUnit = (meter: string): number => (['6/8', '12/8'].includes(meter) ? 1.5 : 1)
export const BACKINGS = {
  drone: '持续和弦',
  major: 'I–V–vi–IV',
  minor: 'i–VI–III–VII',
  'ii-v-i': 'ii–V–I',
  blues: '标准十二小节',
  quick: 'Quick change',
  'minor-blues': '小调十二小节'
}
export interface HarmonyBar {
  root: number
  quality: string
  numeral: string
}
export function progression(name: string, tonic: number): HarmonyBar[] {
  const patterns: Record<string, [number, string, string][]> = {
    drone: [[0, 'major', 'I']],
    major: [
      [0, 'major', 'I'],
      [7, 'major', 'V'],
      [9, 'minor', 'vi'],
      [5, 'major', 'IV']
    ],
    minor: [
      [0, 'minor', 'i'],
      [8, 'major', 'VI'],
      [3, 'major', 'III'],
      [10, 'major', 'VII']
    ],
    'ii-v-i': [
      [2, 'm7', 'ii7'],
      [7, '7', 'V7'],
      [0, 'maj7', 'Imaj7'],
      [0, 'maj7', 'Imaj7']
    ],
    blues: [
      ...[0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7].map(
        (n) => [n, '7', n === 0 ? 'I7' : n === 5 ? 'IV7' : 'V7'] as [number, string, string]
      )
    ],
    quick: [
      ...[0, 5, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7].map(
        (n) => [n, '7', n === 0 ? 'I7' : n === 5 ? 'IV7' : 'V7'] as [number, string, string]
      )
    ],
    'minor-blues': [
      [0, 'm7', 'i7'],
      [0, 'm7', 'i7'],
      [0, 'm7', 'i7'],
      [0, 'm7', 'i7'],
      [5, 'm7', 'iv7'],
      [5, 'm7', 'iv7'],
      [0, 'm7', 'i7'],
      [0, 'm7', 'i7'],
      [8, '7', '♭VI7'],
      [7, '7', 'V7'],
      [0, 'm7', 'i7'],
      [7, '7', 'V7']
    ]
  }
  return (patterns[name] ?? patterns.drone!).map(([root, quality, numeral]) => ({
    root: mod(root + tonic),
    quality,
    numeral
  }))
}
export interface GeneratedExercise {
  events: MusicEvent[]
  beats: number
  bars: number
  warning?: string
}
function choosePath(midis: number[], pool: Position[]): Position[] {
  let previous: Position | undefined
  return midis.map((midi) => {
    const candidates = pool.filter((p) => p.midi === midi)
    const cost = (p: Position): number =>
      previous
        ? Math.abs(p.fret - previous.fret) * 2 + Math.abs(p.string - previous.string) * 1.2
        : p.fret + p.string * 0.01
    candidates.sort((a, b) => cost(a) - cost(b))
    const selected = candidates[0]
    if (!selected) throw new Error('当前弦组和品位无法完整演奏这组音，请扩大范围或调整调性。')
    previous = selected
    return selected
  })
}
export function generateExercise(
  tuning: Tuning,
  capo: number,
  config: ExerciseConfig,
  technique?: Technique
): GeneratedExercise {
  if (config.mode === 'apply' && config.material === 'chord' && config.backing !== 'drone') {
    const bars = progression(config.backing, config.root)
    const length = meterLength(config.meter)
    const events: MusicEvent[] = []
    for (let bar = 0; bar < bars.length; bar++) {
      const harmony = bars[bar]!
      const source = generateExercise(
        tuning,
        capo,
        {
          ...config,
          root: harmony.root,
          chord: harmony.quality,
          mode: 'demo',
          pattern: config.pattern === 'chord' ? 'chord' : 'scale'
        },
        technique
      )
      let cursor = 0,
        index = 0
      while (cursor < length - 1e-8) {
        const event = source.events[index % source.events.length]!
        const duration = Math.min(event.duration, length - cursor)
        events.push({ ...event, id: `e${events.length}`, beat: bar * length + cursor, duration })
        cursor += duration
        index++
      }
    }
    return { events, beats: bars.length * length, bars: bars.length }
  }
  const pool = positions(tuning, capo, config.minFret, config.maxFret, config.strings)
  if (!pool.length) throw new Error('当前品位或弦组没有可用位置。')
  const material = (config.material === 'chord' ? CHORDS[config.chord] : SCALES[config.scale]) ?? SCALES.major!
  if (
    ['triads', 'sevenths'].includes(config.pattern) &&
    (config.material !== 'scale' || material.semitones.length !== 7)
  )
    throw new Error('调内三／七和弦组按七声音阶构建。请选择大调、小调或七声调式；和弦材料可直接选择顺阶琶音。')
  const pcs = material.semitones.map((n) => mod(n + config.root))
  const available = [...new Set(pool.filter((p) => pcs.includes(mod(p.midi))).map((p) => p.midi))].sort((a, b) => a - b)
  if (!available.length) throw new Error('当前范围没有所选材料的音符，请扩大品位范围。')
  const rootIndex = available.findIndex((m) => mod(m) === config.root)
  const first = rootIndex >= 0 ? available[rootIndex]! : available[0]!
  let line = available.filter((m) => m >= first && m <= first + 24)
  const requiredNotes =
    ({ three: 3, four: 4, thirds: 3, return: 3, reorder: 4, triads: 5, sevenths: 7 } as Record<string, number>)[
      config.pattern
    ] ?? 1
  if (line.length < requiredNotes) line = available
  if (!['rhythm', 'blues', 'chromatic', 'chord'].includes(config.pattern)) {
    for (let index = 1; index < line.length; index++) {
      let expected = line[index - 1]! + 1
      while (!pcs.includes(mod(expected))) expected++
      if (line[index] !== expected)
        throw new Error('当前弦组／品位缺少中间音，不能完整生成该音型。请扩大范围，避免把跳音误当作顺阶。')
    }
  }
  if (config.direction === 'down') line.reverse()
  const patterns: Record<string, number[]> = {
    three: [0, 1, 2],
    four: [0, 1, 2, 3],
    thirds: [0, 2],
    return: [0, 1, 2, 1],
    reorder: [0, 2, 1, 3],
    triads: [0, 2, 4],
    sevenths: [0, 2, 4, 6]
  }
  let pitches: number[] = []
  if (patterns[config.pattern]) {
    const offsets = patterns[config.pattern]!
    if (line.length <= Math.max(...offsets))
      throw new Error('所选范围不足以容纳完整音型，请扩大品位范围或减少音型长度。')
    if (config.sequence === 'chromatic') {
      const motif = offsets.map((i) => line[i]!)
      const sign = config.direction === 'down' ? -1 : 1
      for (let shift = 0; shift < 24; shift += config.step) {
        const next = motif.map((m) => m + sign * shift)
        if (!next.every((m) => pool.some((p) => p.midi === m))) break
        pitches.push(...next)
      }
    } else
      for (let i = 0; i + Math.max(...offsets) < line.length; i += config.step)
        pitches.push(...offsets.map((j) => line[i + j]!))
  } else pitches = line
  if (config.direction === 'both' && pitches.length > 1) pitches = [...pitches, ...pitches.slice(0, -1).reverse()]
  if (config.pattern === 'chromatic') {
    const targetString = config.strings[0] ?? (tuning.instrument === 'bass' ? tuning.notes.length : 1)
    pitches = pool
      .filter((p) => p.string === targetString)
      .slice(0, 4)
      .map((p) => p.midi)
    if (config.direction === 'down') pitches.reverse()
    if (config.direction === 'both') pitches = [...pitches, ...pitches.slice(0, -1).reverse()]
  }
  const length = meterLength(config.meter)
  const duration = beatUnit(config.meter) / config.subdivision
  const events: MusicEvent[] = []
  let cursor = 0
  function add(notes: Position[], durationValue = duration, special?: Technique): void {
    // Split sustained notes at bar lines. Both the score and transport consume these exact events.
    let remaining = durationValue
    let tied = false
    while (remaining > 0.00001) {
      const barRemainder = length - (cursor % length)
      const chunk = Math.min(remaining, barRemainder < 0.00001 ? length : barRemainder)
      events.push({ id: `e${events.length}`, beat: cursor, duration: chunk, notes, technique: special, tie: tied })
      cursor += chunk
      remaining -= chunk
      tied = notes.length > 0
    }
  }
  if (config.pattern === 'rhythm') {
    const pos = choosePath([first], pool)[0]!
    const count = Math.round(length / duration) * 2
    for (let i = 0; i < count; i++)
      add(i % 8 === 3 || i % 8 === 7 ? [] : [pos], duration, technique ?? (i % 2 ? 'up' : 'down'))
  } else if (config.pattern === 'chord') {
    const voicing = chordVoicings(tuning, config.root, CHORDS[config.chord]!, capo, config).find((v) =>
      v.every(
        (p) =>
          p.fret >= config.minFret &&
          p.fret <= config.maxFret &&
          (!config.strings.length || config.strings.includes(p.string))
      )
    )
    if (!voicing) throw new Error('该弦组／把位没有完整可用和弦指法。请扩大范围，或改用琶音。')
    for (const pos of [...voicing].sort((a, b) => b.string - a.string)) add([pos])
    const pulse = beatUnit(config.meter)
    const align = Math.ceil((cursor - 1e-8) / pulse) * pulse
    while (cursor < align - 1e-8) add([], Math.min(duration, align - cursor))
    add(voicing, pulse, 'down')
    add([], pulse)
  } else if (config.pattern === 'blues') {
    const harmonies = progression(config.backing, config.root)
    const barCount = Math.max(4, harmonies.length)
    for (let bar = 0; bar < barCount; bar++) {
      const harmony = harmonies[bar % harmonies.length]!
      let notes: Position[]
      if (tuning.instrument === 'bass') {
        const availableRoots = pool.filter((p) => mod(p.midi) === harmony.root).sort((a, b) => a.midi - b.midi)
        const start = availableRoots[0]
        if (!start) throw new Error('当前把位缺少伴奏和弦根音，请扩大范围以生成完整低音线。')
        const intervals = CHORDS[harmony.quality]!.semitones
        const targets = [0, intervals[1]!, 7, harmony.quality === 'minor' || harmony.quality === 'm7' ? 10 : 9].map(
          (n) => {
            const candidates = pool
              .filter((p) => mod(p.midi) === mod(start.midi + n))
              .sort((a, b) => Math.abs(a.midi - (start.midi + n)) - Math.abs(b.midi - (start.midi + n)))
            return candidates[0]?.midi ?? start.midi
          }
        )
        notes = choosePath(targets, pool)
      } else
        notes = choosePath(
          [line[0]!, line[Math.min(2, line.length - 1)]!, line[Math.min(3, line.length - 1)]!, line[0]!],
          pool
        )
      const ticks = Math.round(length / duration)
      for (let i = 0; i < ticks; i++) {
        const isRest = tuning.instrument !== 'bass' && (bar % 2 === 1 || i >= ticks - 2)
        add(isRest ? [] : [notes[i % notes.length]!], duration, technique)
      }
    }
  } else {
    const path = choosePath(pitches.slice(0, 192), pool)
    for (let i = 0; i < path.length; i++) {
      const p = path[i]!
      const next = path[i + 1]
      const compatible = next && p.string === next.string && p.fret !== next.fret
      const mark =
        technique === 'hammer' || technique === 'pull' || technique === 'slide'
          ? compatible
            ? technique === 'slide'
              ? 'slide'
              : next.fret > p.fret
                ? 'hammer'
                : 'pull'
            : undefined
          : technique
      add([p], duration, mark)
      if (mark === 'bend') events[events.length - 1]!.bend = 2
    }
  }
  if (!events.length) throw new Error('没有可生成的练习，请调整范围。')
  let bars = Math.max(1, Math.ceil((cursor - 1e-8) / length))
  let beats = bars * length
  while (cursor < beats - 1e-8) add([], Math.min(duration, beats - cursor))
  if (config.mode === 'apply') {
    const harmonyBars = progression(config.backing, config.root).length
    if (harmonyBars > bars) {
      const source = events.slice()
      const sourceBeats = beats
      const targetBeats = Math.ceil(harmonyBars / bars) * sourceBeats
      while (cursor < targetBeats - 1e-8) {
        for (const event of source) add(event.notes, event.duration, event.technique)
      }
      beats = targetBeats
      bars = Math.round(beats / length)
    }
  }
  return { events, beats, bars }
}
