import type { ToneAsset } from '@shared/arsenal.js'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface NamModel extends Record<string, unknown> {
  architecture: string
  config: Record<string, unknown>
  weights: number[]
}

function invalid(): never { throw new Error('NAM 模型结构无效') }

function validateModel(model: unknown, depth = 0): asserts model is NamModel {
  if (depth > 16 || !record(model) || typeof model.architecture !== 'string' || !model.architecture
    || !record(model.config) || !Array.isArray(model.weights)
    || model.weights.some(x => typeof x !== 'number' || !Number.isFinite(x))) invalid()

  // NAM A2 stores Full/Lite weights inside complete child models. Its own
  // weights array is empty; ordinary architectures still require weights.
  if (model.architecture === 'SlimmableContainer') {
    const submodels = model.config.submodels
    if (!Array.isArray(submodels) || !submodels.length) invalid()
    let previous = 0
    for (const entry of submodels) {
      if (!record(entry) || typeof entry.max_value !== 'number' || !Number.isFinite(entry.max_value)
        || entry.max_value <= previous) invalid()
      validateModel(entry.model, depth + 1)
      previous = entry.max_value
    }
    if (previous < 1) invalid()
  } else if (!model.weights.length) invalid()
}

export function decodeNam(bytes: Buffer, fallbackSampleRate?: number): Pick<ToneAsset, 'architecture' | 'sampleRate' | 'metadata' | 'slimmable'> {
  let model: unknown
  try { model = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('NAM 文件不是有效 JSON') }
  validateModel(model)
  const sampleRate = Number(model.sample_rate || fallbackSampleRate)
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new Error('NAM 缺少训练采样率，请在导入旁选择正确的采样率后重试')
  const architecture = model.architecture
  return {
    architecture, sampleRate,
    metadata: record(model.metadata) ? model.metadata : {},
    slimmable: architecture.toLowerCase().includes('slim') || Boolean(model.config.slimmable)
  }
}
