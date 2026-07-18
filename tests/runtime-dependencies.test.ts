import { describe, expect, it } from 'vitest'
import {
  PYTHON_RUNTIME_REQUIREMENTS,
  PYTHON_RUNTIME_VERSIONS,
  pythonRuntimeRequirements,
  pythonRuntimeVersions
} from '../src/main/runtime-dependencies.js'

describe('managed Python runtime dependencies', () => {
  it('uses the current dependency set on Windows Python 3.12', () => {
    const windows = pythonRuntimeVersions('win32', 'x64')
    expect(windows).toEqual({
      torch: '2.11.0',
      torchaudio: '2.11.0',
      demucs: '4.1.0'
    })
    expect(pythonRuntimeRequirements(windows)).toEqual([
      'torch==2.11.0',
      'torchaudio==2.11.0',
      'demucs==4.1.0',
      'soundfile>=0.13,<1'
    ])
  })

  it('selects matching native macOS wheel pairs', () => {
    const intel = pythonRuntimeVersions('darwin', 'x64')
    const appleSilicon = pythonRuntimeVersions('darwin', 'arm64')
    expect(pythonRuntimeRequirements(intel).slice(0, 2)).toEqual(['torch==2.2.2', 'torchaudio==2.2.2'])
    expect(pythonRuntimeRequirements(appleSilicon).slice(0, 2)).toEqual(['torch==2.11.0', 'torchaudio==2.11.0'])
  })

  it('exports the dependency set for the running process', () => {
    expect(PYTHON_RUNTIME_VERSIONS).toEqual(pythonRuntimeVersions())
    expect(PYTHON_RUNTIME_REQUIREMENTS).toEqual(pythonRuntimeRequirements(PYTHON_RUNTIME_VERSIONS))
  })
})
