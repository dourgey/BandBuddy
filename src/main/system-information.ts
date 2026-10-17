import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { app, net, systemPreferences } from 'electron'
import type { AppSettings, MediaCapabilities, RecordingDeviceInfo, RuntimeInfo } from '@shared/domain.js'
import type { DiagnosticReport, EnvironmentState, SystemInformationReport, SystemInformationSection } from '@shared/environment.js'
import { DiagnosticError, errorEvidence, redactDiagnostics } from './diagnostic-errors.js'
import { hardwareSnapshot } from './hardware-diagnostics.js'
import { detectWindowsVcRuntime } from './windows-prerequisites.js'
import { runProcess } from './process.js'

interface Sources {
  settings(): AppSettings
  environment(): EnvironmentState
  runtime(): RuntimeInfo
  media(): MediaCapabilities
  diagnostics(): DiagnosticReport
  devices(): Promise<RecordingDeviceInfo[]>
}
const capabilityLabels = { startup: '软件启动', media: '导入与导出', recording: '录音与监听', separation: '本地分轨', acceleration: '硬件加速' }
const checkLabels = { unchecked: '未检测', passed: '通过', failed: '失败', blocked: '受依赖阻塞', notApplicable: '不适用' }
const levelLabels = { inventory: '信息检测', integrity: '文件完整性', launch: '程序启动', imports: '依赖导入', inference: '实际运算', stream: '设备流' }
const phaseLabels = { checking: '正在检测', preparing: '正在准备', ready: '已就绪', paused: '已暂停', waitingNetwork: '等待网络', waitingIdle: '等待空闲', needsAction: '需要处理' }
const bytes = (value: number): string => `${(value / 1024 ** 3).toFixed(2)} GiB`
const failure = (error: unknown): string => { const evidence = errorEvidence(error); return `读取失败 · ${evidence.code} · ${evidence.message}` }
const row = (label: string, value: unknown): SystemInformationSection['rows'][number] => ({ label, value: value === undefined || value === null || value === '' ? '未检测 / 未提供' : String(value) })

async function bounded<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DiagnosticError('INFORMATION_TIMEOUT', `信息读取超过 ${ms / 1000} 秒`)), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
async function storageRow(label: string, directory: string): Promise<SystemInformationSection['rows'][number]> {
  try {
    const space = await bounded(() => statfs(directory), 3000)
    return row(label, `可用 ${bytes(space.bavail * space.bsize)} / 总计 ${bytes(space.blocks * space.bsize)}`)
  } catch (error) { return row(label, failure(error)) }
}

/** Read-only collection. Never installs components, runs inference, or opens an audio stream. */
export class SystemInformationService {
  private collecting: Promise<SystemInformationReport> | null = null
  private readonly reports = new Map<string, string>()
  constructor(private readonly sources: Sources) {}

  collect(): Promise<SystemInformationReport> {
    if (!this.collecting) this.collecting = this.read().finally(() => { this.collecting = null })
    return this.collecting
  }
  text(id: string): string {
    const text = this.reports.get(id)
    if (!text) throw new DiagnosticError('SYSTEM_INFORMATION_EXPIRED', '信息已过期，请刷新后再复制。')
    return text
  }
  private async read(): Promise<SystemInformationReport> {
    const settings = this.sources.settings()
    const roots = [app.getPath('userData'), app.getPath('temp'), settings.libraryRoot, settings.runtimeRoot, settings.modelRoot]
    const [hardware, audio, graphics, vc, disks] = await Promise.all([
      bounded(hardwareSnapshot, 12_000).then(value => ({ value }), error => ({ error })),
      bounded(() => this.sources.devices(), 20_000).then(value => ({ value }), error => ({ error })),
      bounded(() => app.getGPUInfo('complete'), 5000).then(value => ({ value }), error => ({ error })),
      process.platform === 'win32' ? detectWindowsVcRuntime(runProcess) : Promise.resolve(null),
      Promise.all(roots.map((root, index) => storageRow(['应用数据盘', '系统临时盘', '曲库所在盘', '运行环境所在盘', '模型所在盘'][index]!, root)))
    ])
    const environment = this.sources.environment(), runtime = this.sources.runtime(), media = this.sources.media(), diagnostic = this.sources.diagnostics()
    const sections: SystemInformationSection[] = []
    const add = (title: string, rows: SystemInformationSection['rows']): void => { sections.push({ title, rows }) }
    add('应用与操作系统', [
      row('BandBuddy', `${app.getVersion()} · ${app.isPackaged ? '发行构建' : '开发构建'}`),
      row('操作系统', `${os.version()} · ${os.release()}`), row('架构', `${process.platform} / ${process.arch}（系统 ${os.machine()}）`),
      row('Electron / Chromium / Node.js', `${process.versions.electron ?? '未知'} / ${process.versions.chrome ?? '未知'} / ${process.versions.node}`),
      row('原生模块 ABI', process.versions.modules), row('系统已运行', `${(os.uptime() / 3600).toFixed(1)} 小时`),
      row('运行编号', diagnostic.runId), row('安全模式', environment.safeMode ? '已开启' : '未开启')
    ])
    const hw = 'value' in hardware ? hardware.value : null
    add('处理器与内存', [
      row('处理器', hw?.cpu ?? os.cpus()[0]?.model), row('逻辑处理器 / 可用并行数', `${os.cpus().length} / ${os.availableParallelism()}`),
      row('物理内存', bytes(hw?.totalMemory ?? os.totalmem())), row('当前可用内存', bytes(hw?.availableMemory ?? os.freemem())),
      ...('error' in hardware ? [row('硬件探测', failure(hardware.error))] : hw?.probeError ? [row('硬件探测', failure(hw.probeError))] : [])
    ])
    const nativeDevices = hw?.devices ?? []
    const driverRows = (kind: string): SystemInformationSection['rows'] => nativeDevices.filter(device => device.kind === kind).map(device => row(device.name ?? '未命名设备', [
      device.manufacturer, `驱动 ${device.driverVersion || '未提供'}`, device.driverProvider,
      `设备状态 ${device.status ?? '未知'} / 问题码 ${device.problemCode ?? '未知'}`, device.probeError ? `探测错误 ${device.probeError}` : ''
    ].filter(Boolean).join(' · ')))
    const gpuRows = driverRows('display')
    if (!gpuRows.length) gpuRows.push(row('系统显示设备', process.platform === 'win32' ? '本次未获得设备清单，不能据此判断没有显卡' : '见下方图形进程信息'))
    if ('value' in graphics && graphics.value && typeof graphics.value === 'object') {
      const value = graphics.value as Record<string, unknown>
      const devices = Array.isArray(value.gpuDevice) ? value.gpuDevice : []
      for (const [index, device] of devices.entries()) {
        if (!device || typeof device !== 'object') continue
        const fields = ['vendorString', 'deviceString', 'driverVendor', 'driverVersion', 'vendorId', 'deviceId', 'active']
        gpuRows.push(row(`图形进程 GPU ${index + 1}`, fields.filter(key => ['string', 'number', 'boolean'].includes(typeof device[key])).map(key => `${key}=${device[key]}`).join(' · ')))
      }
      if (!devices.length) gpuRows.push(row('图形进程信息', '未返回设备信息'))
    } else if ('error' in graphics) gpuRows.push(row('图形进程信息', failure(graphics.error)))
    if (runtime.gpu) gpuRows.push(row('分轨 GPU（最近检测）', `${runtime.gpu.name} · 驱动 ${runtime.gpu.driverVersion} · 显存 ${runtime.gpu.memoryMb} MiB`))
    add('显卡与驱动', gpuRows)

    const devices = 'value' in audio ? audio.value : []
    const configuration = settings.recordingAudio
    const backend = configuration.backend === 'auto' ? process.platform === 'darwin' ? 'coreaudio' : 'wasapi-shared' : configuration.backend
    const selected = (input: boolean): string => {
      const id = input ? configuration.inputDeviceId : configuration.outputDeviceId
      const device = devices.find(device => device.backend === backend && (input ? device.inputChannels : device.outputChannels) > 0 && (id ? device.id === id : input ? device.defaultInput : device.defaultOutput))
      return device ? device.name : 'error' in audio ? '设备枚举失败，无法确认当前选择' : id ? '指定设备未枚举到' : '系统默认（未枚举到默认设备）'
    }
    let permission: string
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      permission = `${{ 'not-determined': '尚未授权', granted: '已允许', denied: '已拒绝', restricted: '受系统限制', unknown: '未知' }[status]}（${status}）`
    } catch (error) { permission = failure(error) }
    add('音频设备与录音配置', [
      row('播放引擎 / 音频后端', `${configuration.desktopEngine === 'native' ? '原生引擎' : '兼容引擎'} / ${configuration.backend}（${backend}）`),
      row('选定输入', selected(true)), row('选定输出', selected(false)),
      row('输入通道', `${configuration.inputChannelMode} · ${configuration.inputChannels.map(channel => channel + 1).join(', ')}`),
      row('采样率 / 缓冲', `${configuration.sampleRate ? `${configuration.sampleRate} Hz` : '自动'} / ${configuration.bufferFrames ? `${configuration.bufferFrames} 帧` : '自动'}`), row('麦克风系统权限', permission),
      row('设备流', '此信息采集未打开麦克风；流验证结果见环境检测状态'),
      ...('error' in audio ? [row('音频枚举', failure(audio.error))] : devices.length ? devices.map(device => row(`${device.name} · ${device.backend}`, `${device.inputChannels} 输入 / ${device.outputChannels} 输出 · 支持 ${device.sampleRates.join(', ') || '未报告'} Hz · 首选 ${device.preferredSampleRate} Hz`)) : [row('音频枚举', '未返回音频设备')]),
      ...driverRows('audio')
    ])
    const check = (component: string): string => {
      const checks = (environment.checks ?? []).filter(item => item.component === component)
      return checks.length ? checks.map(item => `${item.stage}：${checkLabels[item.status]}`).join('；') : '未检测'
    }
    add('分轨与媒体组件（最近检测）', [
      row('分轨状态', `${runtime.status} · ${runtime.stage}`), row('计算设备', `首选 ${settings.preferredDevice} / 当前选择 ${runtime.selectedDevice}（是否可用以运算检测为准）`),
      row('Python', runtime.pythonVersion), row('PyTorch / CUDA', `${runtime.torchVersion ?? '未检测'} / ${runtime.cudaVersion ?? '未检测 / 不适用'}`),
      row('依赖', check('dependencies')), row('模型', check('models')),
      row('Windows VC++', vc ? vc.probeError ? failure(vc.probeError) : `${vc.version ?? '未安装'} · ${vc.supported ? '版本满足要求' : '未满足要求'}` : '不适用'),
      row('FFmpeg', `${media.ffmpegVersion} · ${{ unchecked: '未检测', checking: '检测中', verified: '验证通过', failed: '验证失败' }[media.ffmpegVerification]}`),
      row('媒体处理格式', `${media.internalSampleRate} Hz / ${media.internalChannels} 声道 / ${media.internalBitDepth} bit`),
      row('支持导入', media.supportedInputFormats.join(', ')), row('支持导出', media.supportedExportFormats.join(', '))
    ])
    add('环境检测状态', [
      row('总体状态', `${phaseLabels[environment.phase]} · ${environment.message}`), row('主动暂停', environment.pausedByUser ? '是' : '否'),
      ...Object.entries(environment.capabilities).map(([key, value]) => row(capabilityLabels[key as keyof typeof capabilityLabels], { unchecked: '未检测', ready: '可用', unavailable: '尚未就绪' }[value])),
      ...(environment.checks ?? []).map(item => row(item.stage, `${checkLabels[item.status]} · ${levelLabels[item.level]}${item.checkedAt ? ` · ${item.checkedAt}` : ' · 无检测时间'}${item.blockedBy ? ` · 依赖 ${item.blockedBy}` : ''}${item.detail ? ` · ${item.detail}` : ''}`))
    ])
    add('网络与存储', [
      row('系统网络信号', net.isOnline() ? '在线（不代表下载来源可达）' : '离线'), row('代理模式', { system: '跟随系统', manual: '手动代理（地址和凭据已隐藏）', none: '不使用代理' }[settings.network.proxyMode]),
      row('Python / PyTorch 来源', `${settings.network.pythonIndexUrl || '默认'} / ${settings.network.pytorchIndexUrl || '默认'}`),
      ...disks, row('磁盘说明', '按目录所在卷读取剩余空间；相同卷会重复显示，未测试写入')
    ])
    add('当前问题与处理记录', environment.issues.length ? environment.issues.flatMap(issue => [
      row(`${capabilityLabels[issue.capability]} · ${issue.stage ?? '未知阶段'}`, `${issue.code} · ${issue.message}`),
      row('诊断编号 / 原因判断', `${issue.diagnosticId ?? '未分配'} / ${issue.confidence === 'confirmed' ? '已确认' : issue.confidence === 'suspected' ? '可能原因' : '原因待确认'}`),
      row('原始证据', issue.evidence?.message), row('已尝试', issue.attempts?.map(attempt => `${attempt.at} ${attempt.action} → ${attempt.result}`).join('\n') || '尚未执行修复'),
      row('下一步', issue.nextSteps?.join('\n') || '在运行状态中重新检测或查看诊断')
    ]) : [row('当前问题', '没有记录到当前故障；未检测项仍需检测')])
    if (diagnostic.persistenceError) sections.at(-1)!.rows.push(row('诊断保存', failure(diagnostic.persistenceError)))

    // Only allowlisted data is exposed. Display and clipboard share this exact sanitized snapshot.
    const clean = JSON.parse(redactDiagnostics(sections, roots)) as SystemInformationSection[]
    const id = randomUUID(), collectedAt = new Date().toISOString()
    const text = ['BandBuddy 系统与环境信息', `采集时间：${collectedAt}`, `信息编号：${id}`, '硬件按需读取；环境状态来自最近检测。未读取音频、账户信息；本地路径与网络凭据已隐藏。',
      ...clean.map(section => `\n【${section.title}】\n${section.rows.map(item => `${item.label}：${item.value}`).join('\n')}`)].join('\n')
    this.reports.set(id, text)
    while (this.reports.size > 5) this.reports.delete(this.reports.keys().next().value!)
    return { id, collectedAt, sections: clean, text }
  }
}
