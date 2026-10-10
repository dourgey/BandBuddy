import { describe, expect, it } from 'vitest'
import { createDefaultPracticeState } from '../packages/shared/src/domain.js'
import { createDefaultSongEq, normalizeSongEq } from '../packages/shared/src/equalizer.js'
import { practiceStateSchema, songEqSchema } from '../packages/shared/src/ipc.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { usePlayerStore } from '../src/renderer/src/player-store.js'

describe('song EQ state compatibility', () => {
  it('normalizes legacy and damaged nested settings without sharing mutable defaults', () => {
    const first = createDefaultSongEq(), second = normalizeSongEq(undefined)
    first.graphicGains[0] = 4; first.nodes[0]!.gainDb = 6
    expect(second.graphicGains[0]).toBe(0); expect(second.nodes[0]!.gainDb).toBe(0)
    const damaged = normalizeSongEq({ enabled: true, mode: 'bad', graphicGains: [NaN, 80], nodes: [{ id: 'x', frequency: 0, gainDb: Infinity, q: 30 }, { id: 'x' }, null] })
    expect(damaged.mode).toBe('graphic')
    expect(damaged.graphicGains.slice(0, 2)).toEqual([0, 12])
    expect(damaged.nodes[0]).toEqual({ id: 'x', frequency: 20, gainDb: 0, q: 12 })
    expect(new Set(damaged.nodes.map(node => node.id)).size).toBe(3)
  })

  it('accepts empty parametric banks and rejects unsafe IPC parameters', () => {
    const eq = createDefaultSongEq(); eq.nodes = []
    expect(songEqSchema.parse(eq).nodes).toEqual([])
    for (const invalid of [
      { ...eq, graphicGains: [0] },
      { ...eq, nodes: [{ id: 'a', frequency: 20001, gainDb: 0, q: 1 }] },
      { ...eq, nodes: [{ id: 'a', frequency: 100, gainDb: 0, q: 0.1 }] },
      { ...eq, nodes: Array.from({ length: 9 }, (_, i) => ({ id: String(i), frequency: 100, gainDb: 0, q: 1 })) },
      { ...eq, nodes: [createDefaultSongEq().nodes[0], createDefaultSongEq().nodes[0]] }
    ]) expect(songEqSchema.safeParse(invalid).success).toBe(false)
  })

  it('defaults omitted EQ on IPC and song load while preserving separate banks', () => {
    const practice = createDefaultPracticeState(fixtureSongs[0]!.id)
    const { eq: omitted, ...legacy } = practice
    expect(practiceStateSchema.parse(legacy).eq).toEqual(createDefaultSongEq())
    const song = fixtureDetail(fixtureSongs[0]!); song.practice = legacy as typeof practice
    usePlayerStore.getState().loadSong(song)
    expect(usePlayerStore.getState().practice?.eq).toEqual(createDefaultSongEq())
    const eq = createDefaultSongEq(); eq.enabled = true; eq.graphicGains[2] = 6; eq.nodes[1]!.gainDb = -4
    usePlayerStore.getState().patchPractice({ eq })
    usePlayerStore.getState().patchPractice({ eq: { ...eq, mode: 'parametric' } })
    expect(usePlayerStore.getState().practice?.eq.graphicGains[2]).toBe(6)
    expect(usePlayerStore.getState().practice?.eq.nodes[1]!.gainDb).toBe(-4)
    usePlayerStore.getState().unload()
  })
})
