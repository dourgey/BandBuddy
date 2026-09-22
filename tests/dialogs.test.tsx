// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App.js'
import { ExportDialog, ImportDialog, MetadataDialog, SettingsDrawer, SongActionsDialog } from '../src/renderer/src/components/Dialogs.js'
import { fixtureDetail, fixtureSongs } from '../src/renderer/src/fixtures.js'
import { installFixtureBridge } from '../src/renderer/src/mock-bridge.js'

describe('library dialogs', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'bandbuddy', { configurable: true, writable: true, value: undefined })
    installFixtureBridge()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('starts each import session with fresh metadata', async () => {
    const choices = [
      { path: 'C:/Music/歌曲 A.mp3', name: '歌曲 A.mp3', inferredTitle: '歌曲 A' },
      { path: 'C:/Music/歌曲 B.mp3', name: '歌曲 B.mp3', inferredTitle: '歌曲 B' }
    ]
    vi.spyOn(window.bandbuddy.library, 'chooseSource').mockImplementation(async () => choices.shift() ?? null)
    const props = {
      onOpenChange: vi.fn(), onImported: vi.fn(), onOpenDuplicate: vi.fn(), onNeedsRuntime: vi.fn()
    }
    const { rerender } = render(<ImportDialog open {...props} />)

    fireEvent.click(screen.getByText('选择音频或视频文件'))
    await waitFor(() => expect((screen.getByLabelText('歌曲标题') as HTMLInputElement).value).toBe('歌曲 A'))
    fireEvent.change(screen.getByLabelText('艺术家'), { target: { value: '艺术家 A' } })

    rerender(<ImportDialog open={false} {...props} />)
    rerender(<ImportDialog open {...props} />)
    await waitFor(() => expect((screen.getByLabelText('歌曲标题') as HTMLInputElement).value).toBe(''))
    expect((screen.getByLabelText('艺术家') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByText('选择音频或视频文件'))
    await waitFor(() => expect((screen.getByLabelText('歌曲标题') as HTMLInputElement).value).toBe('歌曲 B'))
    expect(screen.queryByText(/导入已有分轨/)).toBeNull()
  })

  it('accepts a dropped AAC and submits its native path', async () => {
    const nativePath = 'C:/Music/新歌曲.AAC'
    vi.spyOn(window.bandbuddy.library, 'getPathForFile').mockReturnValue(nativePath)
    const submit = vi.spyOn(window.bandbuddy.library, 'importSource')
    render(<ImportDialog open onOpenChange={vi.fn()} onImported={vi.fn()} onOpenDuplicate={vi.fn()} onNeedsRuntime={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /选择音频或视频文件/ })
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['audio'], '新歌曲.AAC')] } })
    expect((screen.getByLabelText('歌曲标题') as HTMLInputElement).value).toBe('新歌曲')
    fireEvent.click(screen.getByRole('button', { name: '导入并处理' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ filePath: nativePath, title: '新歌曲' })))
  })

  it('rejects unsupported and multiple dropped files', () => {
    render(<ImportDialog open onOpenChange={vi.fn()} onImported={vi.fn()} onOpenDuplicate={vi.fn()} onNeedsRuntime={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /选择音频或视频文件/ })
    fireEvent.drop(zone, { dataTransfer: { files: [new File([''], 'notes.txt')] } })
    expect(screen.getByText('不支持此文件格式，请拖入音频或视频文件')).toBeTruthy()
    fireEvent.drop(zone, { dataTransfer: { files: [new File([''], 'a.mp3'), new File([''], 'b.mp4')] } })
    expect(screen.getByText('请每次拖入一个音频或视频文件')).toBeTruthy()
    expect((screen.getByRole('button', { name: '导入并处理' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('imports existing stems with preset and custom names and confirms padding without a runtime prompt', async () => {
    vi.spyOn(window.bandbuddy.library, 'chooseStems').mockResolvedValue([
      { path: '/music/vocals.wav', name: 'vocals.wav', inferredTitle: 'vocals' },
      { path: '/music/guitar.wav', name: 'guitar.wav', inferredTitle: 'guitar' }
    ])
    const imported = vi.spyOn(window.bandbuddy.library, 'importStems')
      .mockResolvedValueOnce({ songId: null, jobId: null, duplicate: null, needsPadding: true, durationDifferenceMs: 1200 })
      .mockResolvedValueOnce({ songId: 'new-song', jobId: 'job', duplicate: null })
    const onImported = vi.fn(); const onNeedsRuntime = vi.fn()
    render(<ImportDialog open onOpenChange={vi.fn()} onImported={onImported} onOpenDuplicate={vi.fn()} onNeedsRuntime={onNeedsRuntime} />)
    fireEvent.click(screen.getByRole('button', { name: '已分轨数据' }))
    fireEvent.click(screen.getByRole('button', { name: '选择分轨文件' }))
    await screen.findByLabelText('轨道 1 名称')
    fireEvent.change(screen.getByLabelText('轨道 1 预设名称'), { target: { value: 'piano' } })
    expect((screen.getByLabelText('轨道 1 名称') as HTMLInputElement).value).toBe('钢琴')
    fireEvent.change(screen.getByLabelText('轨道 2 名称'), { target: { value: '我的节奏吉他' } })
    fireEvent.click(screen.getByRole('button', { name: '导入并处理' }))
    await screen.findByRole('button', { name: '补静音并导入' })
    expect(onImported).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '补静音并导入' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('new-song'))
    expect(imported).toHaveBeenLastCalledWith(expect.objectContaining({ files: [
      expect.objectContaining({ name: '钢琴' }), expect.objectContaining({ name: '我的节奏吉他' })
    ], padMismatched: true }))
    expect(onNeedsRuntime).not.toHaveBeenCalled()
  })

  it('starts LAN mode immediately and displays the actual fallback port', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    const enabled = vi.spyOn(window.bandbuddy.lan, 'setEnabled').mockResolvedValue({ enabled: true, port: 60233, urls: ['http://192.168.1.20:60233/s/session/'], error: null })
    render(<SettingsDrawer open onOpenChange={vi.fn()} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '网络与共享' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /开启局域网练琴与同步/ }))
    await waitFor(() => expect(enabled).toHaveBeenCalledWith(true))
    expect((await screen.findByLabelText('局域网访问地址') as HTMLInputElement).value).toBe('http://192.168.1.20:60233/s/session/')
  })

  it('saves desktop lyric font size', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    const update = vi.spyOn(window.bandbuddy.settings, 'update')
    render(<SettingsDrawer open onOpenChange={vi.fn()} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '通用与显示' }))
    fireEvent.change(screen.getByRole('slider', { name: /桌面歌词文字大小/ }), { target: { value: '48' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ desktopLyricsFontSize: 48 })))
  })

  it('offers metadata editing from the song actions menu', () => {
    const onOpenChange = vi.fn()
    const onEditMetadata = vi.fn()
    render(<SongActionsDialog
      open
      onOpenChange={onOpenChange}
      song={fixtureSongs[0]!}
      onOpen={() => undefined}
      onEditMetadata={onEditMetadata}
      onImportLyrics={() => undefined}
      onReveal={() => undefined}
      onReseparate={() => undefined}
      onDelete={() => undefined}
    />)

    fireEvent.click(screen.getByRole('button', { name: /编辑歌曲信息/ }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onEditMetadata).toHaveBeenCalledTimes(1)
  })

  it('opens the selected library song metadata from its three-dot menu', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>)

    await screen.findByRole('heading', { name: '曲库' })
    const menus = screen.getAllByRole('button', { name: '歌曲菜单' })
    fireEvent.click(menus[0]!)

    const editButton = await screen.findByRole('button', { name: /编辑歌曲信息/ })
    fireEvent.click(editButton)
    await waitFor(() => expect((screen.getByLabelText('歌曲标题') as HTMLInputElement).value).toBe(fixtureSongs[0]!.title))
  })

  it('shows low-confidence key candidates and saves a manual correction', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const update = vi.spyOn(window.bandbuddy.library, 'update')
    render(<MetadataDialog open onOpenChange={() => undefined} song={song} onSaved={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: '识别歌曲调' }))
    await screen.findByText('置信度较低，前三候选')
    expect(screen.getByText(/E minor/)).toBeTruthy()
    expect(screen.getByText('可能转调')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('主音'), { target: { value: 'A' } })
    fireEvent.change(screen.getByLabelText('调式'), { target: { value: 'minor' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      id: song.id,
      patch: expect.objectContaining({ musicalKey: 'A minor', musicalKeySource: 'manual' })
    })))
  })

  it('always carries the current pitch into stem exports', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    const practice = { ...song.practice, pitchSemitones: 4 }
    vi.spyOn(window.bandbuddy.export, 'choosePath').mockResolvedValue('C:/Exports')
    const start = vi.spyOn(window.bandbuddy.export, 'start')
    render(<ExportDialog open onOpenChange={() => undefined} song={song} practice={practice} onBeforeStart={async () => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: /分别导出音轨/ }))
    expect(screen.getByText('导出当前 +4 半音')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /选择位置并导出/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'stems', applyPitchShift: true, pitchSemitones: 4
    })))
  })

  it('defaults stem export to the visible guitar mode and can include hidden alternatives', async () => {
    const song = fixtureDetail(fixtureSongs[0]!)
    vi.spyOn(window.bandbuddy.export, 'choosePath').mockResolvedValue('C:/Exports')
    const start = vi.spyOn(window.bandbuddy.export, 'start')
    render(<ExportDialog open onOpenChange={() => undefined} song={song} practice={song.practice} onBeforeStart={async () => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: /分别导出音轨/ }))
    expect(screen.getByText(/包含隐藏吉他备选轨/).textContent).toContain('Acoustic / Lead / Rhythm')
    fireEvent.click(screen.getByRole('checkbox', { name: /包含隐藏吉他备选轨/ }))
    fireEvent.click(screen.getByRole('button', { name: /选择位置并导出/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'stems',
      stemTypes: expect.arrayContaining(['guitar', 'acoustic_guitar', 'lead_guitar', 'rhythm_guitar'])
    })))
    expect(start.mock.calls[0]![0].stemTypes).toHaveLength(9)
  })

  it('saves the high-quality switch as a future-task setting', async () => {
    const [settings, runtime] = await Promise.all([
      window.bandbuddy.settings.get(),
      window.bandbuddy.runtime.get()
    ])
    const update = vi.spyOn(window.bandbuddy.settings, 'update').mockImplementation(async (next) => next)
    render(<SettingsDrawer
      open
      onOpenChange={() => undefined}
      runtime={runtime}
      settings={{ ...settings, highQualityStems: false }}
      onSaved={() => undefined}
      onRefresh={() => undefined}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分轨与运行环境' }))
    expect(screen.getByText('新分轨保存为 320 kbps MP3，节省空间')).toBeTruthy()
    expect(screen.getByText('仅影响后续分轨；已有歌曲需重新分轨才会改变格式')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '高音质分轨' }))
    expect(screen.getByText('新分轨保存为 24-bit FLAC，占用空间较大')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ highQualityStems: true })))
  })

  it('saves the draggable guitar quality tier for future tasks', async () => {
    const [settings, runtime] = await Promise.all([
      window.bandbuddy.settings.get(),
      window.bandbuddy.runtime.get()
    ])
    const update = vi.spyOn(window.bandbuddy.settings, 'update').mockImplementation(async (next) => next)
    render(<SettingsDrawer
      open
      onOpenChange={() => undefined}
      runtime={runtime}
      settings={{ ...settings, guitarSeparationQuality: 'balanced' }}
      onSaved={() => undefined}
      onRefresh={() => undefined}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分轨与运行环境' }))
    const slider = screen.getByRole('slider', { name: '吉他分轨档位' })
    expect(slider.getAttribute('aria-valuetext')).toBe('平衡')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(screen.getByText(/快速\/预览质量/)).toBeTruthy()
    expect(slider.getAttribute('aria-valuetext')).toBe('极速')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ guitarSeparationQuality: 'fast' })))
  })

  it('enables debug mode immediately and reveals the debug log from settings', async () => {
    const [settings, runtime] = await Promise.all([
      window.bandbuddy.settings.get(),
      window.bandbuddy.runtime.get()
    ])
    const update = vi.spyOn(window.bandbuddy.settings, 'update')
    const setDebugMode = vi.spyOn(window.bandbuddy.settings, 'setDebugMode').mockImplementation(async (enabled) => ({ ...settings, debugMode: enabled }))
    const revealDebugLog = vi.spyOn(window.bandbuddy.settings, 'revealDebugLog')
    const onSaved = vi.fn()

    render(<SettingsDrawer
      open
      onOpenChange={() => undefined}
      runtime={runtime}
      settings={settings}
      onSaved={onSaved}
      onRefresh={() => undefined}
    />)

    fireEvent.click(screen.getByRole('button', { name: '存储与诊断' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug 模式' }))
    await waitFor(() => expect(setDebugMode).toHaveBeenCalledWith(true))
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ debugMode: true }))
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '打开日志位置' }))
    await waitFor(() => expect(revealDebugLog).toHaveBeenCalledTimes(1))
  })
  it('keeps changes across category dialogs and saves them together', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    const update = vi.spyOn(window.bandbuddy.settings, 'update')
    render(<SettingsDrawer open onOpenChange={vi.fn()} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)

    expect(screen.queryByRole('checkbox', { name: '高音质分轨' })).toBeNull()
    expect(screen.queryByLabelText('延迟模式')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '分轨与运行环境' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '高音质分轨' }))
    fireEvent.click(screen.getByRole('button', { name: '返回分类' }))
    fireEvent.click(screen.getByRole('button', { name: '音频与录音' }))
    fireEvent.change(screen.getByLabelText('延迟模式'), { target: { value: 'playback' } })
    fireEvent.click(screen.getByRole('button', { name: '返回分类' }))
    fireEvent.click(screen.getByRole('button', { name: '分轨与运行环境' }))
    expect((screen.getByRole('checkbox', { name: '高音质分轨' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ highQualityStems: true, latencyMode: 'playback' })))
  })

  it('keeps the settings dialog and draft available when saving fails', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    const onOpenChange = vi.fn()
    vi.spyOn(window.bandbuddy.settings, 'update').mockRejectedValue(new Error('保存失败'))
    render(<SettingsDrawer open onOpenChange={onOpenChange} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '音频与录音' }))
    fireEvent.change(screen.getByLabelText('延迟模式'), { target: { value: 'playback' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('延迟模式') as HTMLSelectElement).value).toBe('playback')
  })

  it('stops input testing when returning to settings categories', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    const start = vi.spyOn(window.bandbuddy.recording, 'startTest')
    const stop = vi.spyOn(window.bandbuddy.recording, 'stopTest')
    render(<SettingsDrawer open onOpenChange={vi.fn()} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '音频与录音' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并测试输入' }))
    await screen.findByRole('button', { name: '停止输入测试' })
    expect(start).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '返回分类' }))
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
  })

  it('does not start a pending input test after its category closes', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    let finishSave!: (value: typeof settings) => void
    vi.spyOn(window.bandbuddy.settings, 'update').mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    const start = vi.spyOn(window.bandbuddy.recording, 'startTest')
    const onSaved = vi.fn()
    render(<SettingsDrawer open onOpenChange={vi.fn()} runtime={runtime} settings={settings} onSaved={onSaved} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '音频与录音' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并测试输入' }))
    fireEvent.click(screen.getByRole('button', { name: '返回分类' }))
    finishSave(settings)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(start).not.toHaveBeenCalled()
  })

  it('returns to categories with Escape without closing settings', async () => {
    const settings = await window.bandbuddy.settings.get()
    const runtime = await window.bandbuddy.runtime.get()
    const onOpenChange = vi.fn()
    render(<SettingsDrawer open onOpenChange={onOpenChange} runtime={runtime} settings={settings} onSaved={vi.fn()} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '通用与显示' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: '通用与显示' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '通用与显示' })).toBeNull())
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

})
