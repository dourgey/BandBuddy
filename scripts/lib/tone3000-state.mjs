// Integration-test adapter for the documented source state of TONE3000 0.0.12.
// JUCE ValueTree framing: NUL strings, compressed counts, tagged variants.
// Used only to configure the installed binary; no TONE3000 DSP is reimplemented.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const string = value => Buffer.from(value + '\0')
function count(value) {
  const bytes = []
  do { bytes.push(value & 255); value >>>= 8 } while (value)
  return Buffer.from([bytes.length, ...bytes])
}
function variant(value) {
  let bytes
  if (Buffer.isBuffer(value)) bytes = Buffer.concat([Buffer.from([8]), value])
  else if (typeof value === 'string') bytes = Buffer.concat([Buffer.from([5]), string(value)])
  else if (typeof value === 'boolean') bytes = Buffer.from([value ? 2 : 3])
  else if (typeof value === 'number' && Number.isFinite(value)) {
    bytes = Buffer.alloc(9); bytes[0] = 4; bytes.writeDoubleLE(value, 1)
  } else throw new Error('Unsupported reference-state property')
  return Buffer.concat([count(bytes.length), bytes])
}
const tree = (type, props = {}, children = []) => ({ type, props, children })
function encode(value) {
  const properties = Object.entries(value.props)
  return Buffer.concat([string(value.type), count(properties.length),
    ...properties.flatMap(([key, item]) => [string(key), variant(item)]),
    count(value.children.length), ...value.children.map(encode)])
}
function decode(bytes, start) {
  let position = start
  const readString = () => {
    const end = bytes.indexOf(0, position)
    assert.ok(end >= position, 'Reference state string is truncated')
    const value = bytes.toString('utf8', position, end); position = end + 1; return value
  }
  const readCount = () => {
    const size = bytes[position++]
    assert.ok(size <= 4 && position + size <= bytes.length, 'Reference state count is invalid')
    let value = 0
    for (let i = 0; i < size; i++) value += bytes[position++] * 2 ** (i * 8)
    return value
  }
  const read = (depth = 0) => {
    assert.ok(depth <= 16, 'Reference state is too deeply nested')
    const type = readString(), props = {}, children = []
    const properties = readCount(); assert.ok(properties <= 4096)
    for (let i = 0; i < properties; i++) {
      const key = readString(), size = readCount(), end = position + size
      assert.ok(size > 0 && end <= bytes.length, 'Reference state variant is truncated')
      const tag = bytes[position++]
      let value
      if (tag === 1 && size === 5) value = bytes.readInt32LE(position)
      else if (tag === 2 || tag === 3) value = tag === 2
      else if (tag === 4 && size === 9) value = bytes.readDoubleLE(position)
      else if (tag === 5) value = bytes.toString('utf8', position, end - 1)
      else if (tag === 8) value = Buffer.from(bytes.subarray(position, end))
      else throw new Error(`Unsupported reference-state variant ${tag}`)
      position = end; props[key] = value
    }
    const length = readCount(); assert.ok(length <= 4096)
    for (let i = 0; i < length; i++) children.push(read(depth + 1))
    return tree(type, props, children)
  }
  return { value: read(), get end() { return position } }
}

export function tone3000State(defaultState, { modelPath, modelBytes, quality, normalized, calibration }) {
  assert.equal(defaultState.readUInt32LE(0), 0x42425354, 'Expected BandBuddy opaque-state envelope')
  assert.equal(defaultState.readUInt32LE(4), 1)
  assert.equal(defaultState.readUInt32LE(12), 0, 'Unexpected controller state')
  assert.equal(defaultState.toString('ascii', 16, 20), 'T3KB', 'Unsupported TONE3000 state format')
  const decoded = decode(defaultState, 20), state = decoded.value
  assert.equal(state.type, 'TONE3000State'); assert.equal(state.props.schemaVersion, 1)
  state.props.inputMode = 'dual'; state.props.activePresetId = ''; state.props.activePresetName = 'BandBuddy NAM comparison'
  const parameters = state.children.find(child => child.type === 'PARAMETERS')
  const overrides = { inputLevel: .5, outputLevel: .5, gateEnabled: 0, toneEqEnabled: 0,
    calibrateInput: calibration === null ? 0 : 1, inputCalibrationLevel: calibration ?? 12,
    osEnabled: 0, pitchEnabled: 0, spreadEnabled: 0, alignEnabled: 0, outputBalance: .5, targetLoudness: -18 }
  for (const child of parameters.children) if (child.props.id in overrides) child.props.value = overrides[child.props.id]
  for (const id of Object.keys(overrides)) assert.ok(parameters.children.some(child => child.props.id === id), `Missing reference parameter ${id}`)
  const snapshot = state.children.find(child => child.type === 'ChainSnapshot')
  snapshot.props.stereoEnabled = false; snapshot.props.branchAfterBlockId = ''
  const tone = { id: -1, title: 'Local NAM comparison', format: 'nam', models: [{ id: 1, name: 'Local NAM comparison', model_url: pathToFileURL(modelPath).href }] }
  const block = tree('ChainBlock', { id: 'bandbuddy-nam-comparison', type: 'nam', enabled: true,
    normalize: normalized, slimSize: quality === 'full' ? 1 : 0, inputGain: .5, outputGain: .5,
    mix: 1, toneId: -1, toneJson: JSON.stringify(tone), activeModelId: 1 },
  [tree('ModelCache', {}, [tree('CachedModel', { modelId: 1, data: modelBytes })])])
  snapshot.children.find(child => child.type === 'ChainBlocks').children = [block]
  snapshot.children.find(child => child.type === 'RightChainBlocks').children = []
  const body = Buffer.concat([Buffer.from('T3KB'), encode(state), defaultState.subarray(decoded.end)])
  const envelope = Buffer.alloc(16)
  envelope.writeUInt32LE(0x42425354); envelope.writeUInt32LE(1, 4); envelope.writeUInt32LE(body.length, 8)
  return Buffer.concat([envelope, body])
}
