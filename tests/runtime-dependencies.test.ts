import { describe, expect, it } from 'vitest'
import { PYTHON_RUNTIME_REQUIREMENTS, PYTHON_RUNTIME_VERSIONS } from '../src/main/runtime-dependencies.js'

describe('managed Python runtime dependencies', () => {
  it('uses the dependency set verified on Windows Python 3.12', () => {
    expect(PYTHON_RUNTIME_VERSIONS).toEqual({
      torch: '2.11.0',
      torchaudio: '2.11.0',
      demucs: '4.1.0'
    })
    expect(PYTHON_RUNTIME_REQUIREMENTS).toEqual([
      'torch==2.11.0',
      'torchaudio==2.11.0',
      'demucs==4.1.0',
      'soundfile>=0.13,<1'
    ])
  })
})
