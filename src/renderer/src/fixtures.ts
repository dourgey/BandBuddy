import { createDefaultPracticeState, STEM_ORDER, type SongDetail, type SongSummary } from '@shared/domain.js'

const now = new Date().toISOString()

export const fixtureSongs: SongSummary[] = [
  ['11111111-1111-4111-8111-111111111111', '光辉岁月', 'Beyond', 298000],
  ['22222222-2222-4222-8222-222222222222', 'Hotel California', 'Eagles', 390000],
  ['33333333-3333-4333-8333-333333333333', 'Smells Like Teen Spirit', 'Nirvana', 301000],
  ['44444444-4444-4444-8444-444444444444', '夜空中最亮的星', '逃跑计划', 252000],
  ['55555555-5555-4555-8555-555555555555', 'Bohemian Rhapsody', 'Queen', 355000],
  ['66666666-6666-4666-8666-666666666666', '平凡之路', '朴树', 302000],
  ['77777777-7777-4777-8777-777777777777', 'Shape of You', 'Ed Sheeran', 233000]
].map(([id, title, artist, durationMs], index) => ({
  id: String(id), title: String(title), artist: String(artist), durationMs: Number(durationMs), artworkUrl: null,
  favorite: index === 1, status: index === 3 ? 'processing' : 'ready', progress: index === 3 ? 0.68 : 1,
  phase: index === 3 ? '正在分离' : null, stemTypes: [...STEM_ORDER], createdAt: now, updatedAt: now,
  lastPracticedAt: new Date(Date.now() - index * 86_400_000).toISOString()
}))

export function fixtureDetail(song: SongSummary): SongDetail {
  return {
    ...song,
    bpm: song.title === 'Hotel California' ? 74 : null,
    beatOffsetMs: 0,
    musicalKey: song.title === 'Hotel California' ? 'Em' : null,
    timeSignature: song.title === 'Hotel California' ? '4/4' : null,
    sourceFormat: 'flac',
    sampleRate: 44100,
    channels: 2,
    stems: STEM_ORDER.map((type, index) => ({
      id: `${index + 1}${song.id.slice(1)}`,
      songId: song.id,
      separationId: '99999999-9999-4999-8999-999999999999',
      type,
      durationMs: song.durationMs,
      sampleRate: 44100,
      channels: 2,
      mediaUrl: '',
      peaksUrl: null
    })),
    practice: createDefaultPracticeState(song.id)
  }
}
