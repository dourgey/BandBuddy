export interface PythonRuntimeVersions {
  torch: string
  torchaudio: string
  demucs: string
}

export function pythonRuntimeVersions(platform = process.platform, arch = process.arch): PythonRuntimeVersions {
  const torchVersion = platform === 'darwin' && arch === 'x64' ? '2.2.2' : '2.11.0'
  return {
    torch: torchVersion,
    torchaudio: torchVersion,
    demucs: '4.1.0'
  }
}

export function pythonRuntimeRequirements(versions: PythonRuntimeVersions): readonly string[] {
  return [
    `torch==${versions.torch}`,
    `torchaudio==${versions.torchaudio}`,
    `demucs==${versions.demucs}`,
    'soundfile>=0.13,<1'
  ]
}

export const PYTHON_RUNTIME_VERSIONS = pythonRuntimeVersions()

// Keep torch and torchaudio independently pinned: their release numbers and
// wheel availability must match. Current PyTorch macOS wheels are arm64-only,
// so Intel Macs use the final verified x64 pair with CPython 3.12 wheels.
export const PYTHON_RUNTIME_REQUIREMENTS = pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS)
