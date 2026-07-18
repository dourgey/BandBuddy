import toolManifest from '../../resources/tool-manifest.json' with { type: 'json' }

export interface ToolSource {
  version: string
  format: 'zip' | 'tar.gz' | 'raw'
  url: string
  archive: string
  sha256: string
}

export interface ToolFile {
  source: string
  role: 'uv' | 'ffmpeg' | 'ffprobe' | 'ffmpegDependency' | 'license' | 'notice'
  entrySuffix?: string
  fallbackEntry?: string
  output: string
  sha256: string
  executable?: boolean
}

export interface ToolTarget {
  ffmpegVersion: string
  ffmpegLicense: string
  sources: Record<string, ToolSource>
  files: ToolFile[]
}

export function currentToolTarget(platform = process.platform, arch = process.arch): ToolTarget {
  const key = `${platform}-${arch}`
  const targets = toolManifest.targets as unknown as Record<string, ToolTarget>
  const target = targets[key]
  if (!target) throw new Error(`UNSUPPORTED_TOOL_TARGET:${key}`)
  return target
}

export function toolFile(target: ToolTarget, role: ToolFile['role']): ToolFile {
  const file = target.files.find((candidate) => candidate.role === role)
  if (!file) throw new Error(`TOOL_MANIFEST_ROLE_MISSING:${role}`)
  return file
}
