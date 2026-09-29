export const DRUM_LANES = [
  { id: 'kick', name: '底鼓', midi: 36 },
  { id: 'snare', name: '军鼓', midi: 38 },
  { id: 'sidestick', name: '边击', midi: 37 },
  { id: 'clap', name: '拍手', midi: 39 },
  { id: 'closedHat', name: '闭镲', midi: 42 },
  { id: 'openHat', name: '开镲', midi: 33 },
  { id: 'tom', name: '通鼓', midi: 48 },
  { id: 'cymbal', name: '镲片', midi: 49 },
  { id: 'percussion', name: '打击乐', midi: 56 }
] as const

export type DrumLaneId = (typeof DRUM_LANES)[number]['id']
export const DRUM_STEPS = 16
export type DrumPattern = Record<DrumLaneId, number>

export interface DrumDraft {
  steps: DrumPattern
  sounds: Record<DrumLaneId, number>
  bpm: number
  swing: number
  volume: number
}

const mask = (...steps: number[]): number => steps.reduce((value, step) => value | (1 << step), 0)
const base = (parts: Partial<DrumPattern>): DrumPattern =>
  Object.fromEntries(DRUM_LANES.map((lane) => [lane.id, parts[lane.id] ?? 0])) as DrumPattern

export const DRUM_PRESETS = [
  { id: 'pop', name: '流行 · 八拍', bpm: 108, swing: 0.5, steps: base({ kick: mask(0, 8), snare: mask(4, 12), closedHat: mask(0, 2, 4, 6, 8, 10, 12, 14) }) },
  { id: 'rock', name: '摇滚 · 强拍', bpm: 116, swing: 0.5, steps: base({ kick: mask(0, 7, 8), snare: mask(4, 12), closedHat: mask(0, 2, 4, 6, 8, 10, 12), openHat: mask(14) }) },
  { id: 'funk', name: '放克 · 切分', bpm: 104, swing: 0.55, steps: base({ kick: mask(0, 3, 8, 10), snare: mask(4, 12, 15), closedHat: mask(0, 2, 3, 4, 6, 8, 10, 11, 12, 14), openHat: mask(7), percussion: mask(6, 14) }) },
  { id: 'hiphop', name: 'Hip-hop · Boom bap', bpm: 88, swing: 0.6, steps: base({ kick: mask(0, 6, 10), snare: mask(4, 12), closedHat: mask(0, 2, 4, 6, 8, 10, 12, 14), openHat: mask(15) }) },
  { id: 'house', name: 'House · 四踩', bpm: 124, swing: 0.5, steps: base({ kick: mask(0, 4, 8, 12), clap: mask(4, 12), closedHat: mask(0, 4, 8, 12), openHat: mask(2, 6, 10, 14) }) },
  { id: 'disco', name: 'Disco · 八分镲', bpm: 120, swing: 0.5, steps: base({ kick: mask(0, 4, 8, 12), snare: mask(4, 12), clap: mask(4, 12), closedHat: mask(0, 2, 4, 8, 10, 12), openHat: mask(6, 14), cymbal: mask(0) }) },
  { id: 'reggae', name: 'Reggae · One drop', bpm: 76, swing: 0.5, steps: base({ kick: mask(8), sidestick: mask(8), closedHat: mask(2, 6, 10, 14), openHat: mask(15), percussion: mask(4, 12) }) },
  { id: 'shuffle', name: 'Shuffle · 摇摆', bpm: 98, swing: 2 / 3, steps: base({ kick: mask(0, 8, 11), snare: mask(4, 12), closedHat: mask(0, 2, 4, 6, 8, 10, 12), openHat: mask(14) }) }
] as const

export type DrumPresetId = (typeof DRUM_PRESETS)[number]['id']

export function defaultDrumDraft(id: DrumPresetId): DrumDraft {
  const preset = DRUM_PRESETS.find((item) => item.id === id)!
  return {
    steps: { ...preset.steps },
    sounds: Object.fromEntries(DRUM_LANES.map((lane) => [lane.id, lane.midi])) as Record<DrumLaneId, number>,
    bpm: preset.bpm,
    swing: preset.swing,
    volume: 0.7
  }
}

export function toggleDrumStep(steps: DrumPattern, lane: DrumLaneId, step: number): DrumPattern {
  if (!Number.isInteger(step) || step < 0 || step >= DRUM_STEPS) return steps
  const next = { ...steps, [lane]: steps[lane] ^ (1 << step) }
  if (lane === 'openHat' && next.openHat & (1 << step)) next.closedHat &= ~(1 << step)
  if (lane === 'closedHat' && next.closedHat & (1 << step)) next.openHat &= ~(1 << step)
  return next
}

export function drumStepTime(step: number, bpm: number, swing: number): number {
  const beat = Math.floor(step / 4)
  const withinBeat = ((step % 4) + 4) % 4
  const position = [0, swing / 2, swing, swing + (1 - swing) / 2][withinBeat]!
  return (beat + position) * 60 / bpm
}
