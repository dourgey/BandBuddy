import { expect, it, vi } from 'vitest'
import { RecordingService } from '../src/main/recording.js'
vi.mock('electron', () => ({ dialog: {}, systemPreferences: {} }))
it('deletes only takes belonging to the requested recording track before removing it', async () => {
  const run = vi.fn(), all = vi.fn(() => [{id:'take-a'},{id:'take-b'}]), remove = vi.fn(async (_takeId: string) => undefined)
  const service = { isActive: () => false, database: { getRecordingTrack: () => ({id:'track-a'}), sqlite: { prepare: vi.fn((sql: string) => sql.startsWith('SELECT') ? {all} : {run}) } }, deleteTake: remove, changed: vi.fn() }
  await RecordingService.prototype.deleteTrack.call(service as never, 'track-a')
  expect(all).toHaveBeenCalledWith('track-a')
  expect(remove.mock.calls.map(call => call[0])).toEqual(['take-a','take-b'])
  expect(run).toHaveBeenCalledWith('track-a')
  expect(service.changed).toHaveBeenCalledOnce()
  service.isActive = () => true
  await expect(RecordingService.prototype.deleteTrack.call(service as never, 'track-a')).rejects.toThrow('请先停止录音')
  expect(run).toHaveBeenCalledOnce()
})
