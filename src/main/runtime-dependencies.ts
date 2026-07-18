export const PYTHON_RUNTIME_VERSIONS = {
  torch: '2.11.0',
  torchaudio: '2.11.0',
  demucs: '4.1.0'
} as const

// Keep torch and torchaudio independently pinned: their latest release numbers
// do not always advance together, and torchaudio requires a matching torch ABI.
export const PYTHON_RUNTIME_REQUIREMENTS = [
  `torch==${PYTHON_RUNTIME_VERSIONS.torch}`,
  `torchaudio==${PYTHON_RUNTIME_VERSIONS.torchaudio}`,
  `demucs==${PYTHON_RUNTIME_VERSIONS.demucs}`,
  'soundfile>=0.13,<1'
] as const
