export interface PythonRuntimeVersions {
  torch: string
  torchaudio: string
  demucs: string
  onnxRuntimeCpu: string
  onnxRuntimeCuda12: string
  onnxRuntimeCuda13: string
}

export type OnnxRuntimeVariant = 'cpu' | 'cuda12' | 'cuda13'

export function pythonRuntimeVersions(platform = process.platform, arch = process.arch): PythonRuntimeVersions {
  if (platform === 'darwin' && arch === 'x64') return {
    torch: '2.2.2', torchaudio: '2.2.2', demucs: '4.1.0',
    onnxRuntimeCpu: '1.23.2', onnxRuntimeCuda12: '1.26.0', onnxRuntimeCuda13: '1.28.0'
  }
  return {
    torch: '2.11.0',
    torchaudio: '2.11.0',
    demucs: '4.1.0',
    onnxRuntimeCpu: '1.28.0',
    onnxRuntimeCuda12: '1.26.0',
    onnxRuntimeCuda13: '1.28.0'
  }
}

export function selectOnnxRuntimeVariant(
  platform: NodeJS.Platform,
  pytorchBackend: string
): OnnxRuntimeVariant {
  if (platform !== 'win32' || pytorchBackend === 'cpu') return 'cpu'
  return pytorchBackend === 'cu130' ? 'cuda13' : 'cuda12'
}

export function pythonRuntimeRequirements(
  versions: PythonRuntimeVersions,
  onnxVariant: OnnxRuntimeVariant = 'cpu'
): readonly string[] {
  const intel = versions.torch === '2.2.2'
  const onnxRequirement = onnxVariant === 'cpu'
    ? `onnxruntime==${versions.onnxRuntimeCpu}`
    : `onnxruntime-gpu==${onnxVariant === 'cuda13' ? versions.onnxRuntimeCuda13 : versions.onnxRuntimeCuda12}`
  return [
    `torch==${versions.torch}`,
    `torchaudio==${versions.torchaudio}`,
    `demucs==${versions.demucs}`,
    intel ? 'numpy==1.26.4' : 'numpy==2.5.2',
    'scipy==1.17.0',
    'soundfile==0.14.0',
    intel ? 'librosa==0.11.0' : 'librosa==1.0.0',
    'PyYAML==6.0.3',
    'einops==0.8.1',
    'beartype==0.18.5',
    'rotary-embedding-torch==0.3.5',
    'packaging==26.2',
    onnxRequirement,
    ...(intel ? ['numba==0.61.2', 'llvmlite==0.44.0', 'sphn==0.1.12'] : [])
  ]
}

export const PYTHON_RUNTIME_VERSIONS = pythonRuntimeVersions()

// Every inference dependency is immutable for the v2.0.1 production chain.
// Intel Macs deliberately use the last official x64 Torch wheels and NumPy 1.x.
export const PYTHON_RUNTIME_REQUIREMENTS = pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS)
