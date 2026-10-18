// Shared AudioWorkletProcessor for all capture sources (Mix, PAFL, Room).
// Buffers incoming render quanta into fixed-size blocks and posts them to
// the main thread as transferable Float32Arrays, one per channel. Keeping
// this generic (role-agnostic) means capture.js can open as many of these
// as the browser will allow and decide what each one means.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.blockFrames = options.processorOptions?.blockFrames || 2048;
    this.buffers = null;
    this.writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channelCount = input.length;
    if (channelCount === 0) return true;

    if (!this.buffers || this.buffers.length !== channelCount) {
      this.buffers = Array.from({ length: channelCount }, () => new Float32Array(this.blockFrames));
      this.writeIndex = 0;
    }

    const frames = input[0].length;
    let offset = 0;
    while (offset < frames) {
      const space = this.blockFrames - this.writeIndex;
      const take = Math.min(space, frames - offset);
      for (let ch = 0; ch < channelCount; ch++) {
        this.buffers[ch].set(input[ch].subarray(offset, offset + take), this.writeIndex);
      }
      this.writeIndex += take;
      offset += take;

      if (this.writeIndex >= this.blockFrames) {
        const toSend = this.buffers.map((b) => b.slice());
        this.port.postMessage(
          { channelBlocks: toSend, sampleRate, blockFrames: this.blockFrames },
          toSend.map((b) => b.buffer)
        );
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('bf-capture', CaptureProcessor);
