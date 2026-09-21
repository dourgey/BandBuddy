import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '../src/main/process.js'
import { runSignalsmithPitchShift } from '../src/main/pitch-shift.js'

const ffmpeg = path.resolve('resources/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const executable = path.resolve('resources/audio-host', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'bandbuddy-audio-host.exe' : 'bandbuddy-audio-host')
it.skipIf(!existsSync(ffmpeg) || !existsSync(executable))('shifts a real FFmpeg extensible float WAV without changing its duration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-pitch-test-'))
  try {
    const input = path.join(root, 'decoded.wav'); const output = path.join(root, 'pitched.wav')
    const result = await runProcess(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le', input])
    expect(result.code, result.stderr).toBe(0)
    const decoded = await readFile(input)
    expect(decoded.readUInt16LE(20)).toBe(0xfffe)
    await runSignalsmithPitchShift({ audioHostExecutable: () => executable } as never, input, output, 12)
    const pitched = await readFile(output)
    expect(pitched.length).toBe(44 + 52920 * 2 * 4)
    let crossings = 0
    for (let frame = 11026; frame < 33075; frame++) {
      if (pitched.readFloatLE(44 + (frame - 1) * 8) < 0 && pitched.readFloatLE(44 + frame * 8) >= 0) crossings++
    }
    expect(crossings).toBeGreaterThan(400)
    expect(crossings).toBeLessThan(480)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 10_000)
