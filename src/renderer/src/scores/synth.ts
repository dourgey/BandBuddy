import { WorkletSynthesizer } from 'spessasynth_lib'

/** Adapter for the pinned SpessaSynth 4.4.5 worklet. Core announces channelAdded
 * after emitting the new channel's initial controller/program changes. Reserve
 * renderer mirrors before loading multi-port MIDI, then consume acknowledgments
 * without duplicating mirrors. Core still owns the real channels and scheduling.
 */
export class ScoreSynthesizer extends WorkletSynthesizer {
  private confirmedChannels?: number
  constructor(context: BaseAudioContext) {
    super(context)
    this.confirmedChannels = this.midiChannels.length
  }
  reserveChannels(count: number): void {
    while (this.midiChannels.length < count) super.addNewChannelInternal()
  }
  protected override addNewChannelInternal(): void {
    // The base constructor creates its first 16 mirrors before our fields exist.
    if (this.confirmedChannels === undefined) { super.addNewChannelInternal(); return }
    if (this.confirmedChannels >= this.midiChannels.length) super.addNewChannelInternal()
    this.confirmedChannels++
  }
}
