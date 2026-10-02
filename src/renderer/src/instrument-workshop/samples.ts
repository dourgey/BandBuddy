/** Bundled local one-shots. Decode once per audio context; scheduling uses its clock. */
export class SampleBank {
  private buffers = new Map<string, AudioBuffer>()
  private loading: Promise<void> | null = null
  constructor(private context: AudioContext) {}
  ready(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      const base = new URL('./samples/', document.baseURI).href
      const response = await fetch(`${base}index.json`)
      if (!response.ok) throw new Error('无法读取练习采样目录')
      const entries = await response.json() as { group: string; midi: number; url: string }[]
      await Promise.all(entries.map(async entry => {
        const file = await fetch(base + entry.url)
        if (!file.ok) throw new Error(`无法读取采样 ${entry.url}`)
        this.buffers.set(`${entry.group}:${entry.midi}`, await this.context.decodeAudioData(await file.arrayBuffer()))
      }))
    })().catch(error => { this.loading = null; throw error })
    return this.loading
  }
  play(group: string, midi: number, time: number, duration: number, level: number, destination: AudioNode, bend = 0, tuning = 440): AudioBufferSourceNode {
    const notes = [...this.buffers.keys()].filter(key => key.startsWith(`${group}:`)).map(key => Number(key.split(':')[1]))
    const nearest = notes.reduce((a, b) => Math.abs(b - midi) < Math.abs(a - midi) ? b : a, notes[0] ?? midi)
    const buffer = this.buffers.get(`${group}:${nearest}`)
    if (!buffer) throw new Error(`采样尚未加载：${group}`)
    const source = this.context.createBufferSource(), gain = this.context.createGain()
    source.buffer = buffer
    const rate = group === 'drums' ? 1 : 2 ** ((midi - nearest) / 12) * tuning / 440
    source.playbackRate.setValueAtTime(rate, time)
    if (bend) source.playbackRate.exponentialRampToValueAtTime(rate * 2 ** (bend / 12), time + duration * .65)
    const end = time + Math.min(Math.max(.03, duration), buffer.duration / rate)
    gain.gain.setValueAtTime(Math.max(0, level), time)
    gain.gain.setValueAtTime(Math.max(0, level), Math.max(time, end - .025))
    gain.gain.linearRampToValueAtTime(0, end)
    source.connect(gain).connect(destination)
    source.addEventListener('ended', () => { source.disconnect(); gain.disconnect() }, { once: true })
    source.start(time); source.stop(end + .005)
    return source
  }
}
