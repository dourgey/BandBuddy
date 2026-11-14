// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import ScoresPage from '../src/renderer/src/pages/ScoresPage.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

vi.mock('../src/renderer/src/scores/PianoRoll.js', () => ({ PianoRoll: () => <div data-testid="roll" />, TRACK_COLORS: ['#333'] }))
vi.mock('../src/renderer/src/woodshed/MusicXmlScore.js', () => ({ MusicXmlScore: ({ xml }: { xml: string }) => <div data-testid="notation">{xml.includes('<score-partwise') ? 'MusicXML ready' : 'Invalid score'}</div> }))

afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.restoreAllMocks() })

it('reads the score library, cached notes and new notation pages while offline', async () => {
  Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
  installFixtureBridge()
  const list = vi.spyOn(window.bandbuddy.scores, 'list'), get = vi.spyOn(window.bandbuddy.scores, 'get'), notation = vi.spyOn(window.bandbuddy.scores, 'notation')
  onlineManager.setOnline(false)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(<QueryClientProvider client={client}><ScoresPage active onSourceHandled={() => {}} onToast={() => {}} /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /夜航.*原创练习/ }))
  await screen.findByTestId('roll')
  expect(list).toHaveBeenCalled(); expect(get).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('tab', { name: '五线谱', exact: true }))
  expect((await screen.findByTestId('notation')).textContent).toBe('MusicXML ready')
  await waitFor(() => expect(notation).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: '下一页乐谱', exact: true }))
  await waitFor(() => expect(notation.mock.calls.some(call => call[3] === 8)).toBe(true))
  result.unmount(); client.clear()
})
