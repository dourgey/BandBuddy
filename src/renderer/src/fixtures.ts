import { createDefaultPracticeState, STEM_ORDER, type SongDetail, type SongSummary } from '@shared/domain.js'
import type { RehearsalSetDetail } from '@shared/rehearsal.js'

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
    lyrics: {
      fileName: 'BandBuddy-demo.lrc',
      title: song.title,
      artist: song.artist || null,
      album: null,
      cues: [
        { timeMs: 0, lines: ['BandBuddy 动态歌词预览'] },
        { timeMs: 6000, lines: ['导入 LRC 后，歌词会跟随播放进度'] },
        { timeMs: 12_000, lines: ['变速、跳转和循环也会保持同步'] },
        { timeMs: 18_000, lines: ['点击播放器右侧的“词”即可关闭'] }
      ]
    },
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
    practice: createDefaultPracticeState(song.id),
    recordingTakes: [],
    recordingTracks: []
  }
}

export const fixtureRehearsal: RehearsalSetDetail = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: '周末排练',
  items: [
    {
      id: 'a1111111-1111-4111-8111-111111111111',
      kind: 'song',
      songId: fixtureSongs[0]!.id,
      title: fixtureSongs[0]!.title,
      artist: fixtureSongs[0]!.artist,
      durationMs: fixtureSongs[0]!.durationMs,
      artworkUrl: fixtureSongs[0]!.artworkUrl,
      available: true
    },
    {
      id: 'a2222222-2222-4222-8222-222222222222',
      kind: 'transition',
      durationMs: 15_000
    },
    {
      id: 'a3333333-3333-4333-8333-333333333333',
      kind: 'song',
      songId: fixtureSongs[1]!.id,
      title: fixtureSongs[1]!.title,
      artist: fixtureSongs[1]!.artist,
      durationMs: fixtureSongs[1]!.durationMs,
      artworkUrl: fixtureSongs[1]!.artworkUrl,
      available: true
    }
  ],
  itemCount: 3,
  songCount: 2,
  recordingTracks: [],
  recordingTakes: [],
  revisions: [],
  createdAt: now,
  updatedAt: now,
  lastOpenedAt: now
}
