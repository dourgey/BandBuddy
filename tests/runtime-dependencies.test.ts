import { describe, expect, it } from 'vitest'
import {
  PYTHON_RUNTIME_REQUIREMENTS,
  PYTHON_RUNTIME_VERSIONS,
  pythonRuntimeRequirements,
  pythonRuntimeVersions,
  selectOnnxRuntimeVariant
} from '../src/main/runtime-dependencies.js'

describe('managed Python runtime dependencies', () => {
  it('uses the current dependency set on Windows Python 3.12', () => {
    const windows = pythonRuntimeVersions('win32', 'x64')
    expect(windows).toEqual({
      torch: '2.11.0',
      torchaudio: '2.11.0',
      demucs: '4.1.0',
      onnxRuntimeCpu: '1.28.0',
      onnxRuntimeCuda12: '1.26.0',
      onnxRuntimeCuda13: '1.28.0'
    })
    expect(pythonRuntimeRequirements(windows)).toEqual([
      'torch==2.11.0',
      'torchaudio==2.11.0',
      'demucs==4.1.0',
      'numpy==2.5.2',
      'scipy==1.17.0',
      'soundfile==0.14.0',
      'librosa==1.0.0',
      'PyYAML==6.0.3',
      'einops==0.8.1',
      'beartype==0.18.5',
      'rotary-embedding-torch==0.3.5',
      'packaging==26.2',
      'onnxruntime==1.28.0'
    ])
  })

  it('uses a compatible official CPU stack for Intel without changing Apple Silicon', () => {
    const intel = pythonRuntimeVersions('darwin', 'x64')
    const appleSilicon = pythonRuntimeVersions('darwin', 'arm64')
    expect(pythonRuntimeRequirements(intel).slice(0, 2)).toEqual(['torch==2.2.2', 'torchaudio==2.2.2'])
    expect(pythonRuntimeRequirements(intel)).toEqual(expect.arrayContaining(['numpy==1.26.4', 'librosa==0.11.0', 'onnxruntime==1.23.2', 'numba==0.61.2', 'llvmlite==0.44.0', 'sphn==0.1.12']))
    expect(pythonRuntimeRequirements(appleSilicon).slice(0, 2)).toEqual(['torch==2.11.0', 'torchaudio==2.11.0'])
  })

  it('installs exactly one hardware-compatible ONNX Runtime package', () => {
    expect(selectOnnxRuntimeVariant('win32', 'cu130')).toBe('cuda13')
    expect(selectOnnxRuntimeVariant('win32', 'cu128')).toBe('cuda12')
    expect(selectOnnxRuntimeVariant('win32', 'cpu')).toBe('cpu')
    expect(selectOnnxRuntimeVariant('darwin', 'cpu')).toBe('cpu')
    expect(pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS, 'cuda13')).toContain('onnxruntime-gpu==1.28.0')
    expect(pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS, 'cuda12')).toContain('onnxruntime-gpu==1.26.0')
    expect(pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS, 'cuda13')).not.toContain('onnxruntime==1.28.0')
  })

  it('exports the dependency set for the running process', () => {
    expect(PYTHON_RUNTIME_VERSIONS).toEqual(pythonRuntimeVersions())
    expect(PYTHON_RUNTIME_REQUIREMENTS).toEqual(pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS))
  })
})
