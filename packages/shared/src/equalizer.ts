export const EQ_FREQUENCIES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const EQ_GAIN_LIMIT = 12
export const EQ_MAX_NODES = 8
export const EQ_GRAPHIC_Q = Math.SQRT2

export interface EqNode {
  id: string
  frequency: number
  gainDb: number
  q: number
}

export interface SongEqState {
  enabled: boolean
  mode: 'graphic' | 'parametric'
  graphicGains: number[]
  nodes: EqNode[]
}

export function createDefaultSongEq(): SongEqState {
  return {
    enabled: false,
    mode: 'graphic',
    graphicGains: EQ_FREQUENCIES.map(() => 0),
    nodes: [80, 400, 2000, 10000].map((frequency, index) => ({ id: `band-${index + 1}`, frequency, gainDb: 0, q: 1 }))
  }
}

const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** Old or partially damaged library records must still open with a safe EQ. */
export function normalizeSongEq(value: unknown): SongEqState {
  const defaults = createDefaultSongEq()
  if (!value || typeof value !== 'object') return defaults
  const saved = value as Partial<SongEqState>
  const ids = new Set<string>()
  return {
    enabled: saved.enabled === true,
    mode: saved.mode === 'parametric' ? 'parametric' : 'graphic',
    graphicGains: EQ_FREQUENCIES.map((_, index) => bounded(saved.graphicGains?.[index], 0, -12, 12)),
    nodes: Array.isArray(saved.nodes) ? saved.nodes.slice(0, EQ_MAX_NODES).map((node, index) => {
      let id = typeof node?.id === 'string' && node.id.length > 0 && node.id.length <= 80 ? node.id : `band-${index + 1}`
      while (ids.has(id)) id = `${id}-${index}`
      ids.add(id)
      return {
        id,
        frequency: bounded(node?.frequency, 1000, 20, 20000),
        gainDb: bounded(node?.gainDb, 0, -12, 12),
        q: bounded(node?.q, 1, 0.2, 12)
      }
    }) : defaults.nodes
  }
}
